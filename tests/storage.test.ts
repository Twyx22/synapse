import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectStorage, migrateStorage, storageDoctor, resolveDataDirectory } from '../src/core/storage.ts';
import { FileStore } from '../src/core/store.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { rankBacklog } from '../src/core/backlog.ts';
import { EvolutionCouncil, EvolutionStore } from '../src/core/evolution.ts';
import { registerTools, type ToolDef } from '../src/opencode/tools.ts';
import { ExperimentStore } from '../src/core/experiments.ts';

async function fixture(t: {after:(fn:()=>Promise<void>)=>void}) {
  const tmp=await mkdtemp(join(tmpdir(),'synapse-storage-')); t.after(()=>rm(tmp,{recursive:true,force:true}));
  const project=join(tmp,'project'), data=join(tmp,'xdg'); await mkdir(project); await mkdir(data);
  const loc=await projectStorage(project,data);
  const engine=new Synapse(new FileStore(loc.legacy),{execute:async()=>({text:'42'})});
  const specs=[{id:'a',title:'A',instruction:'Return 42',review:false},{id:'b',title:'B',instruction:'Return 42',review:false}];
  return {tmp,project,data,loc,engine,specs};
}

test('XDG migration preserves real run, council and experiment documents across source replacement',async t=>{
  const f=await fixture(t);
  const first=await f.engine.plan('fixture',f.specs,1), second=await f.engine.plan('fixture',f.specs,2);
  const exp=await new ExperimentStore(f.engine.store).register([{baselineRunId:first.id,candidateRunId:second.id}],[{taskId:'a',text:'42'},{taskId:'b',text:'42'}],'fixture-model');
  const complete=await f.engine.run(first.id);
  const council=new EvolutionCouncil(new EvolutionStore(join(f.loc.legacy,'evolution')),{execute:async()=>({text:'not used'})});
  await council.scan(complete);
  await council.store.setConfig({autoCouncil:true});
  await mkdir(join(f.loc.legacy,'diagnostics')); await writeFile(join(f.loc.legacy,'diagnostics','synapse.jsonl'),'historic log\n');
  const source=await storageDoctor(f.loc); assert.equal(source.legacy.runs,2);assert.equal(source.initialized,false);
  const migration=await migrateStorage(f.loc,f.loc.legacy,true);assert.equal(migration.imported,4);assert.equal(migration.archived,2);
  assert.ok('backup' in migration); if(!('backup' in migration))throw new Error('No backup');
  assert.equal(await readFile(join(migration.backup!,'diagnostics','synapse.jsonl'),'utf8'),'historic log\n');
  assert.equal((await new EvolutionStore(join(f.loc.directory,'evolution')).getConfig()).autoCouncil,false);
  assert.equal((await new ExperimentStore(new FileStore(f.loc.directory)).list())[0].id,exp.id);
  assert.deepEqual(await new FileStore(f.loc.directory).read(first.id),complete);
  await rename(f.project,join(f.tmp,'old-install'));await mkdir(f.project);
  const fresh=await projectStorage(f.project,f.data);assert.equal(fresh.id,f.loc.id);
  assert.equal((await storageDoctor(fresh)).persistent.runs,2);assert.equal((await storageDoctor(fresh)).legacy.runs,0);
  assert.equal((await migrateStorage(fresh,fresh.legacy,true)).status,'already_migrated');
  assert.equal((await stat(fresh.directory)).mode&0o777,0o700);assert.equal((await stat(join(fresh.directory,first.id+'.json'))).mode&0o777,0o600);
});

test('copy-only migration preserves conflicts, does not follow file symlinks and archives corrupt records',async t=>{
  const f=await fixture(t);const run=await f.engine.plan('original',f.specs,1);
  await migrateStorage(f.loc);const path=join(f.loc.legacy,run.id+'.json');const changed={...run,objective:'conflicting original'};await writeFile(path,JSON.stringify(changed));
  const corrupt=`run_${randomUUID()}.json`,linked=`run_${randomUUID()}.json`;
  await writeFile(join(f.loc.legacy,corrupt),'broken');await symlink(path,join(f.loc.legacy,linked));
  const result=await migrateStorage(f.loc);assert.equal(result.conflicts,1);assert.equal(result.invalid,2);assert.equal(result.imported,0);
  assert.equal((await new FileStore(f.loc.directory).read(run.id)).objective,'original');
  assert.ok('backup' in result); if(!('backup' in result))throw new Error('No backup');
  assert.equal(JSON.parse(await readFile(join(result.backup!,run.id+'.json'),'utf8')).objective,'conflicting original');
  assert.equal(await readFile(join(result.backup!,corrupt),'utf8'),'broken');
  assert.ok(!(await readdir(result.backup!)).includes(linked));
  assert.equal((await storageDoctor(f.loc)).legacy.invalid,2);
  assert.equal((await migrateStorage(f.loc,f.loc.legacy,true)).status,'already_migrated');
});

test('canonical paths share identity but different projects are isolated and doctor is read-only',async t=>{
  const f=await fixture(t);const other=join(f.tmp,'other');await mkdir(other);const alias=join(f.tmp,'alias');await symlink(f.project,alias);
  assert.equal((await projectStorage(alias,f.data)).id,f.loc.id);assert.notEqual((await projectStorage(other,f.data)).id,f.loc.id);
  await storageDoctor(f.loc);assert.deepEqual(await readdir(f.data),[]);
  await f.engine.plan('private',f.specs,1);await migrateStorage(f.loc);
  const otherLoc=await projectStorage(other,f.data);assert.equal((await storageDoctor(otherLoc)).persistent.runs,0);
  await assert.rejects(projectStorage(f.project,'relative'),/absolute/);
});

test('concurrent or interrupted migration fails closed and does not overwrite data',async t=>{
  const f=await fixture(t);await f.engine.plan('fixture',f.specs,1);await migrateStorage(f.loc);
  await mkdir(join(f.loc.directory,'.migration-lock'));
  await assert.rejects(migrateStorage(f.loc),/EEXIST/);
  assert.equal((await storageDoctor(f.loc)).persistent.runs,1);
});

test('backlog is reliability-first and remains advisory, and storage tool rejects restricted sessions',async t=>{
  const f=await fixture(t);const run=await f.engine.plan('fixture',f.specs,1);const done=await f.engine.run(run.id);
  const council=new EvolutionCouncil(new EvolutionStore(join(f.loc.legacy,'evolution')),{execute:async()=>({text:'not used'})});
  const ideas=await council.scan(done);assert.ok(ideas.length);
  const p=ideas[0];const ranked=rankBacklog([{...p,id:'rejected',status:'rejected'},{...p,id:'slow',kind:'review_latency'},{...p,id:'contract',kind:'contract_compliance',status:'ready_for_experiment'}]);
  assert.deepEqual(ranked.map(r=>r.id),['contract','slow']);assert.equal(ranked[0].nextAction,'request_experiment_approval');
  const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>undefined,add:entry=>{defs.set(entry.name,entry);}})},f.engine,council,undefined,id=>id==='worker',undefined,undefined,()=>storageDoctor(f.loc));
  const ctx={sessionID:'coordinator',signal:new AbortController().signal};
  assert.equal(JSON.parse((await defs.get('storage_status')!.execute({},ctx)).content).legacy.runs,1);
  assert.ok(JSON.parse((await defs.get('evolution_backlog')!.execute({},ctx)).content).length);
  for(const name of ['storage_status','evolution_backlog'])await assert.rejects(defs.get(name)!.execute({},{...ctx,sessionID:'worker'}),/coordinator-only/);
});

test('offline CLI migrates then resolves XDG records even after the old directory is removed',async t=>{
  const f=await fixture(t);const run=await f.engine.plan('cli fixture',f.specs,1);
  const {execFileSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const call=(...args:string[])=>execFileSync(process.execPath,['--experimental-strip-types',cli,...args],{cwd:f.project,env:{...process.env,XDG_DATA_HOME:f.data},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(JSON.parse(call('storage','doctor')).legacy.runs,1);
  assert.equal(JSON.parse(call('storage','migrate')).imported,1);
  await rm(f.loc.legacy,{recursive:true});
  assert.equal(JSON.parse(call('storage','doctor')).persistent.runs,1);
  assert.match(call('monitor','--once'),new RegExp(run.id));
  const report=JSON.parse(call('report','--run',run.id));assert.equal(report.runCount,1);assert.ok(report.filePath.startsWith(f.loc.directory+'/reports/'));
});
