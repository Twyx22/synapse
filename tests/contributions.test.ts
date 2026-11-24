import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractPatch, reviewedContribution, stageContribution, validatePatchContract } from '../src/core/contributions.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { FileStore } from '../src/core/store.ts';
import { searchMemory } from '../src/core/memory.ts';
import { registerTools, type ToolDef } from '../src/opencode/tools.ts';
const git = (cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const diff = 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n';
const answer = 'Proposed ordinary text update.\n```diff\n'+diff+'```';
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const dir=await mkdtemp(join(tmpdir(),'synapse-patch-test-'));
  t.after(async()=>{await rm(dir,{recursive:true,force:true});});
  // Keep disposable fixtures independent of the user's branch policy and hooks.
  git(dir,'init','-q','--initial-branch=feature/synapse-fixture');
  const hooks = join(dir,'.git','synapse-test-hooks');
  await mkdir(hooks);
  git(dir,'config','--local','core.hooksPath',hooks);
  git(dir,'config','--local','commit.gpgSign','false');
  git(dir,'config','--local','user.name','Synapse Test');
  git(dir,'config','--local','user.email','test@example.invalid');
  await writeFile(join(dir,'example.txt'),'before\n'); git(dir,'add','example.txt'); git(dir,'commit','-qm','base');
  const baseCommit=git(dir,'rev-parse','HEAD').trim();
  const store=new FileStore(join(dir,'.opencode','synapse-data'));
  const engine=new Synapse(store,{execute:async()=>({text:answer}),review:async()=>({approved:true,reason:'Reviewed scope'})});
  const plan=await engine.plan('Example text change',[{id:'change',title:'Example',instruction:'Prepare diff',patch:{baseCommit,paths:['example.txt']}}]);
  const run=await engine.run(plan.id);
  return {dir,baseCommit,engine,store,run};
}
test('reviewed contribution stages actual Git diff in a detached worktree and preserves dirty original', async t=>{
  const {dir,run}=await fixture(t);
  await writeFile(join(dir,'example.txt'),'local unsaved edit\n');
  const info=reviewedContribution(run,'change');
  const result=await stageContribution(dir,run,'change',info.sha256);
  t.after(async()=>{await rm(result.worktree,{recursive:true,force:true});});
  assert.equal(await readFile(join(result.worktree,'example.txt'),'utf8'),'after\n');
  assert.equal(await readFile(join(dir,'example.txt'),'utf8'),'local unsaved edit\n');
  assert.equal(git(dir,'diff','--cached'),'');
  assert.match(git(result.worktree,'diff','--cached'),/\+after/);
  assert.equal(result.testsExecuted,false);
  git(dir,'worktree','remove','--force',result.worktree);
});
test('digest mismatch and undeclared file scope are refused without creating worktree',async t=>{
  const {dir,run}=await fixture(t);
  const digest=reviewedContribution(run,'change').sha256;
  await assert.rejects(stageContribution(dir,run,'change','bad'),/digest mismatch/);
  run.tasks[0].patch!.paths=['different.txt'];
  await assert.rejects(stageContribution(dir,run,'change',digest),/file scope/);
  assert.equal(git(dir,'worktree','list','--porcelain').match(/^worktree /gm)?.length,1);
});
test('stale Git base is refused',async t=>{
  const {dir,run}=await fixture(t);const digest=reviewedContribution(run,'change').sha256;
  git(dir,'commit','--allow-empty','-qm','new head');
  await assert.rejects(stageContribution(dir,run,'change',digest),/differs from the reviewed base/);
});
test('malformed or unsupported patches and protected paths are rejected',()=>{
  assert.throws(()=>extractPatch('no patch'));
  assert.throws(()=>extractPatch(answer+'\n'+answer));
  assert.throws(()=>extractPatch('```diff\ndiff --git a/x b/x\nnew file mode 120000\n```'));
  for(const path of ['../escape','src/../x','.git/config','src/.env','/absolute','src/.opencode/x']) assert.throws(()=>validatePatchContract({baseCommit:'a'.repeat(40),paths:[path]}));
});
test('unreviewed patch tasks cannot be planned or staged',async t=>{
  const {engine,run,baseCommit}=await fixture(t);
  await assert.rejects(engine.plan('bad',[{id:'x',title:'x',instruction:'x',review:false,patch:{baseCommit,paths:['example.txt']}}]),/require review/);
  run.tasks[0].review=false;
  assert.throws(()=>reviewedContribution(run,'change'),/independently reviewed/);
});
test('invalid worker patch fails before review',async t=>{
  const {store,baseCommit}=await fixture(t);let reviewed=0;
  const engine=new Synapse(store,{execute:async()=>({text:'not a patch'}),review:async()=>{reviewed++;return {approved:true,reason:'bad'};}});
  const run=await engine.plan('invalid',[{id:'x',title:'x',instruction:'x',maxAttempts:1,patch:{baseCommit,paths:['example.txt']}}]);
  assert.equal((await engine.run(run.id)).status,'failed');assert.equal(reviewed,0);
});
test('local memory retrieves reviewed evidence and ignores unreviewed and damaged runs',async t=>{
  const {store,engine,run}=await fixture(t);
  const unreviewed=await engine.plan('Example',[{id:'ignored',title:'Example',instruction:'x',review:false}]);await engine.run(unreviewed.id);
  await writeFile(join(store.directory,'run_00000000-0000-0000-0000-000000000000.json'),'{broken');
  const found=await searchMemory(store,'example');
  assert.equal(found.unreadable,1);assert.equal(found.hits.length,1);assert.equal(found.hits[0].runId,run.id);
  assert.equal((await searchMemory(store,'unrelated')).hits.length,0);
  await assert.rejects(searchMemory(store,'example',21));
});
test('new inspection and memory tools are coordinator-only',async t=>{
  const {engine,run}=await fixture(t);const defs=new Map<string,ToolDef>();
  await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},engine,undefined,undefined,id=>id==='worker');
  const ctx={sessionID:'coordinator',signal:new AbortController().signal};
  const info=JSON.parse((await defs.get('contribution_inspect')!.execute({runId:run.id,taskId:'change'},ctx)).content);
  assert.equal(info.patch,diff);
  for(const [name,args] of [['contribution_inspect',{runId:run.id,taskId:'change'}],['memory_search',{query:'example'}]] as const) await assert.rejects(defs.get(name)!.execute(args,{...ctx,sessionID:'worker'}),/coordinator-only/);
});
test('offline contribution CLI stages a reviewed patch and logs metadata only',async t=>{
  const {dir,run,store}=await fixture(t);
  const cli = new URL('../src/cli.ts',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const call=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',fileURLToPath(cli),...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const args=['--project',dir,'--run',run.id,'--task','change'];
  const info=call('inspect',...args);
  const result=call('stage',...args,'--sha256',info.sha256);
  t.after(async()=>{await rm(result.worktree,{recursive:true,force:true});});
  const {readdir}=await import('node:fs/promises');
  const logs=await readdir(join(store.directory,'diagnostics'));
  const contents=(await Promise.all(logs.filter(n=>n.endsWith('.jsonl')).map(n=>readFile(join(store.directory,'diagnostics',n),'utf8')))).join('');
  assert.match(contents,/contribution.staged/);assert.doesNotMatch(contents,/\+after|diff --git/);
  git(dir,'worktree','remove','--force',result.worktree);
});
