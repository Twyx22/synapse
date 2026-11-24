import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileStore } from '../src/core/store.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { acquireLock, inspectLocks } from '../src/core/locks.ts';
import { doctor } from '../src/core/doctor.ts';
import { CostLedger } from '../src/core/ledger.ts';
import { economicAdvice } from '../src/core/economics.ts';
import { registerTools,type ToolDef } from '../src/opencode/tools.ts';
import { EvolutionStore } from '../src/core/evolution.ts';
const exec=promisify(execFile);
const storeUrl=new URL('../src/core/store.ts',import.meta.url).href;
const lockUrl=new URL('../src/core/locks.ts',import.meta.url).href;
async function fixture(t:{after:(f:()=>Promise<void>)=>void}){
 const dir=await mkdtemp(join(tmpdir(),'synapse-v100-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new FileStore(dir),engine=new Synapse(store,{execute:async()=>({text:'ok'})});
 const run=await engine.plan('PRIVATE_OBJECTIVE',[{id:'a',title:'a',instruction:'test',review:false,maxAttempts:1}]);return{dir,store,engine,run};
}
const child=(code:string,...args:string[])=>exec(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,...args],{timeout:15000});
test('four independent processes serialize 64 read-modify-write transactions without loss',async t=>{
 const {dir,store,run}=await fixture(t);
 const code=`import {FileStore} from ${JSON.stringify(storeUrl)};import {randomUUID} from 'node:crypto';const [dir,id,worker]=process.argv.slice(1);const s=new FileStore(dir);for(let i=0;i<16;i++)await s.update(id,async r=>{await new Promise(x=>setTimeout(x,2));r.events.push({id:randomUUID(),type:'test',detail:worker+':'+i,at:new Date().toISOString()});});`;
 await Promise.all(Array.from({length:4},(_,i)=>child(code,dir,run.id,String(i))));const r=await store.read(run.id);assert.equal(r.events.length,64);assert.equal(new Set(r.events.map(e=>e.detail)).size,64);assert.deepEqual((await inspectLocks(dir)).runs,[]);
});
test('execution lease excludes a second engine and a foreign stop while a graph is active',async t=>{
 const {dir,store,run}=await fixture(t);let enter!:()=>void,finish!:()=>void,calls=0;
 const entered=new Promise<void>(r=>enter=r),release=new Promise<void>(r=>finish=r);
 const a=new Synapse(store,{execute:async()=>{calls++;enter();await release;return{text:'ok'};}}),b=new Synapse(new FileStore(dir),{execute:async()=>{calls++;return{text:'unexpected'};}});
 const work=a.run(run.id);await entered;
 try{await assert.rejects(b.run(run.id),/Lock busy/);await assert.rejects(b.stop(run.id),/Lock busy/);assert.equal((await store.read(run.id)).status,'running');assert.equal((await inspectLocks(dir)).runs[0].key,`${run.id}.execute`);}finally{finish();await work;}
 assert.equal(calls,1);assert.equal((await b.run(run.id)).status,'completed');assert.deepEqual((await inspectLocks(dir)).runs,[]);
});
test('crashed independent process leaves execution lock, no automatic stealing, doctor reports attention',async t=>{
 const {dir,run,engine}=await fixture(t);
 await child(`import {acquireLock} from ${JSON.stringify(lockUrl)};await acquireLock(process.argv[1],process.argv[2]+'.execute');process.exit(0);`,dir,run.id);
 await assert.rejects(engine.run(run.id),/Lock busy or abandoned/);const d=await doctor(dir);assert.equal(d.status,'attention');assert.equal(d.checks.find(c=>c.name==='disk_locks')?.status,'attention');assert.doesNotMatch(JSON.stringify(d),/PRIVATE_OBJECTIVE/);
 // Test owns all writers and child is confirmed exited. Simulate explicit offline recovery.
 await rmdir(join(dir,'.locks',`${run.id}.execute`));assert.equal((await engine.run(run.id)).status,'completed');assert.equal((await doctor(dir)).status,'ok');
});
test('release after mutation exception and refusal of unsafe lock names',async t=>{
 const {dir,store,run}=await fixture(t);await assert.rejects(store.update(run.id,()=>{throw Error('injected');}));assert.deepEqual((await inspectLocks(dir)).runs,[]);await assert.rejects(acquireLock(dir,'../invalid'));await store.update(run.id,r=>{r.objective='still writable';});assert.equal((await store.read(run.id)).objective,'still writable');
});
test('functional success without economic coverage is not performance eligible',async t=>{
 const {dir,engine,run}=await fixture(t);const r=await engine.run(run.id);const ledger=new CostLedger(dir);let a=economicAdvice(r,await ledger.summary('',run.id));assert.equal(a.functionalEligible,true);assert.equal(a.economicEligible,false);assert.equal(a.performanceEligible,false);assert.ok(a.findings.includes('incomplete_economic_coverage_no_performance_recommendation'));
 const id={runId:run.id,sessionId:'s',role:'worker' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:100},20);a=economicAdvice(r,await ledger.summary('',run.id));assert.equal(a.economicEligible,true);assert.equal(a.sessionCoverage.minimumObserved,true);assert.equal(a.billingVerified,false);
});
test('doctor refuses worker access and marks corrupt run inventory without exposing source',async t=>{
 const {dir,engine}=await fixture(t);await writeFile(join(dir,'run_00000000-0000-4000-8000-000000000001.json'),'PRIVATE_CORRUPT');const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>defs.set(d.name,d)})},engine,undefined,undefined,id=>id==='worker');const tool=defs.get('doctor')!,signal=new AbortController().signal;await assert.rejects(tool.execute({},{sessionID:'worker',signal}));const out=JSON.parse((await tool.execute({},{sessionID:'coordinator',signal})).content);assert.equal(out.status,'attention');assert.equal(out.checks.find((c:any)=>c.name==='run_inventory').status,'unavailable');assert.doesNotMatch(JSON.stringify(out),/PRIVATE_CORRUPT|PRIVATE_OBJECTIVE/);
});
test('independent evolution stores merge concurrent partial config edits',async t=>{
 const {dir}=await fixture(t);const a=new EvolutionStore(join(dir,'evolution')),b=new EvolutionStore(join(dir,'evolution'));await Promise.all([a.setConfig({autoScan:false}),b.setConfig({rounds:2})]);const c=await a.getConfig();assert.equal(c.autoScan,false);assert.equal(c.rounds,2);assert.equal(c.autoCouncil,false);assert.deepEqual((await inspectLocks(dir)).evolution,[]);
});
