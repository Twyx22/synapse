import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from '../src/core/store.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { teamProfiles, teamAdvice } from '../src/core/team.ts';
import { registerTools,type ToolDef } from '../src/opencode/tools.ts';
import { discoverProjects, migrateStorage, projectStorage, storageDoctor, storageReport } from '../src/core/storage.ts';
import { DiagnosticLogger, DiagnosticReports } from '../src/core/diagnostics.ts';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
  const root=await mkdtemp(join(tmpdir(),'synapse-team-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new FileStore(join(root,'data'));
  const engine=new Synapse(store,{execute:async()=>({text:'answer'}),review:async c=>({approved:c.task.role!=='reject',reason:'review verdict'})});
  return {root,store,engine};
}
const task=(id:string,role:string,review=true)=>({id,title:id,instruction:'fixture',role,review,maxAttempts:1});

test('role profiles separate reviewed, unreviewed, rejected and blocked work without counting a planned run',async t=>{
  const {store,engine}=await fixture(t);
  const r=await engine.plan('fixture',[task('a','research'),task('b','research',false),task('c','reject'),{...task('d','research'),dependsOn:['c']}],2);
  await engine.run(r.id);
  await engine.plan('planned',[task('e','research')],1);
  const p=await teamProfiles(store);
  assert.equal(p.terminalRuns,1);assert.equal(p.scanned,2);
  const research=p.profiles.find(x=>x.role==='research')!;
  assert.deepEqual([research.reviewed,research.unreviewed,research.failed,research.blocked,research.runs],[1,1,0,1,1]);
  assert.equal(p.profiles.find(x=>x.role==='reject')!.failed,1);
  assert.equal(research.evidence[0].runId,r.id);
});

test('team advice needs multiple distinct runs, preserves graph and discloses corrupt history',async t=>{
  const {store,engine}=await fixture(t);
  const plan=await engine.plan('target',[task('a','research'),task('b','new')],1);
  for(let i=0;i<3;i++){
    const r=await engine.plan('sample',[task('a','research')],1);await engine.run(r.id);
    const a=await teamAdvice(store,plan); assert.equal(a.roles[0].outcome,i===2?'reviewed_history_available':'insufficient_evidence');
    assert.equal(a.roles[1].outcome,'insufficient_evidence');
  }
  assert.deepEqual(await store.read(plan.id),plan);
  await writeFile(join(store.directory,`run_${randomUUID()}.json`),'bad');
  const bad=await teamAdvice(store,plan);assert.equal(bad.unreadable,1);assert.equal(bad.roles[0].outcome,'insufficient_evidence');
});

test('team tools are coordinator-only and do not create sessions',async t=>{
  const {engine}=await fixture(t);const r=await engine.plan('fixture',[task('a','research')],1);
  const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},engine,undefined,undefined,id=>id==='worker');
  for(const [name,args] of [['team_profiles',{}],['team_advice',{runId:r.id}]] as const){
    const ctx={sessionID:'coordinator',signal:new AbortController().signal};
    await defs.get(name)!.execute(args,ctx);await assert.rejects(defs.get(name)!.execute(args,{...ctx,sessionID:'worker'}),/coordinator-only/);
  }
  assert.equal((await engine.get(r.id)).status,'planned');
});

test('project discovery and report expose current storage identity without exporting other paths',async t=>{
  const {root}=await fixture(t);const data=join(root,'xdg'),a=join(root,'private-a'),b=join(root,'private-b');await mkdir(a);await mkdir(b);
  const one=await projectStorage(a,data),two=await projectStorage(b,data);
  await migrateStorage(one);await migrateStorage(two);
  const e=new Synapse(new FileStore(one.directory),{execute:async()=>({text:'answer'})});await e.plan('secret objective',[task('a','research')],1);
  const list=await discoverProjects(data);assert.equal(list.projects.length,2);assert.equal(list.projects.find(p=>p.projectId===one.id)!.runFiles,1);assert.equal(list.projects.find(p=>p.projectId===two.id)!.runFiles,0);
  const report=await new DiagnosticReports(two.directory,new DiagnosticLogger(join(two.directory,'diagnostics')),()=>storageReport(two,two.directory)).build();
  assert.equal(report.runCount,0);assert.ok(report.warnings.includes('empty_project_history'));assert.ok(report.files.includes('storage.json'));
  const bytes=(await readFile(report.filePath)).toString('utf8');assert.ok(bytes.includes(two.id));assert.ok(!bytes.includes(one.id));assert.ok(!bytes.includes(a));assert.ok(!bytes.includes(b));assert.ok(!bytes.includes('secret objective'));
});

test('mismatched identity fails closed and is excluded from discovery',async t=>{
  const {root}=await fixture(t);const a=join(root,'project');await mkdir(a);const data=join(root,'xdg');const loc=await projectStorage(a,data);await migrateStorage(loc);
  await writeFile(join(loc.directory,'project.json'),JSON.stringify({schema:1,id:loc.id,project:'/unrelated'}));
  await assert.rejects(storageDoctor(loc),/identity mismatch/);const list=await discoverProjects(data);assert.equal(list.invalid,1);assert.equal(list.projects.length,0);
});
