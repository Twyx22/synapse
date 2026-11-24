import { join } from 'node:path';
import { FileStore } from './store.ts';
import { CostLedger } from './ledger.ts';
import { DiagnosticLogger } from './diagnostics.ts';
import { inspectLocks } from './locks.ts';
import { VERSION } from './version.ts';
/** No new model requests or repairs. Snapshot, not a live provider test. */
export async function doctor(directory:string, storageStatus?:()=>Promise<unknown>,resources?:()=>unknown){
 const checks: {name:string;status:'ok'|'attention'|'unavailable';detail?:unknown}[]=[];
 const check=async(name:string,fn:()=>Promise<{attention:boolean;detail:unknown}>)=>{
   try{const r=await fn();checks.push({name,status:r.attention?'attention':'ok',detail:r.detail});}
   catch{checks.push({name,status:'unavailable'});}
 };
 await check('run_inventory',async()=>{const runs=await new FileStore(directory).list();const statuses:Record<string,number>={};for(const r of runs)statuses[r.status]=(statuses[r.status]??0)+1;return{attention:false,detail:{count:runs.length,statuses}}});
 await check('disk_locks',async()=>{const l=await inspectLocks(directory);return{attention:l.runs.length+l.evolution.length>0,detail:l}});
 if(storageStatus)await check('project_storage',async()=>{const s=await storageStatus() as {persistent?:{invalid:number};legacy?:{invalid:number};migrationLockPresent?:boolean;initialized?:boolean};return{attention:!s.initialized||!!s.migrationLockPresent||!!s.persistent?.invalid||!!s.legacy?.invalid,detail:{initialized:s.initialized,persistent:s.persistent,legacy:s.legacy,migrationLockPresent:s.migrationLockPresent}}});
 await check('economic_ledger',async()=>{const log=new DiagnosticLogger(join(directory,'diagnostics'));const s=await new CostLedger(directory).summary(await log.recent());const l=s.ledger;return{attention:!!(l.invalidRecords||l.unavailable||l.retainedWriteErrors||l.unfinished),detail:{...l,observedSessions:s.total.sessions}}});
 if(resources)await check('local_resources',async()=>({attention:false,detail:resources()}));
 return {version:VERSION,status:checks.some(c=>c.status!=='ok')?'attention':'ok',checks,limitations:['Snapshot only; no repair, no model calls, no dependency audit or provider health verification.','Locks may be live or abandoned. Never remove them while any writer or remote session may still be active.','Resource limits remain per engine instance.']};
}
