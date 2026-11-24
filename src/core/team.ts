import { readdir } from 'node:fs/promises';
import type { FileStore } from './store.ts';
import type { RunRecord } from './types.ts';
import { reusable } from './retrospective.ts';

type Evidence = {runId:string; taskId:string; outcome:'reviewed'|'unreviewed'|'failed'; attempts:number};
type Profile = {role:string; reviewed:number; unreviewed:number; failed:number; blocked:number; cancelled:number; runs:number; evidence:Evidence[]; evidenceTruncated:boolean};
/** Exact role labels only; historical observations, not persistent identities or demonstrated skills. */
export async function teamProfiles(store:FileStore, excludeRunId?:string) {
  const names=(await readdir(store.directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/^run_[a-f0-9-]{36}\.json$/.test(n)).sort();
  const selected=names.filter(n=>n!==`${excludeRunId}.json`).slice(0,500);
  const profiles=new Map<string,{profile:Profile; runIds:Set<string>}>();
  let unreadable=0, terminalRuns=0;
  for(const name of selected) {
    try {
      const run=await store.read(name.slice(0,-5));
      if(!['completed','failed','cancelled'].includes(run.status))continue;
      // Validate before accumulating: malformed records cannot contribute partial evidence.
      if(!Array.isArray(run.tasks)||run.tasks.length>128||run.tasks.some(t=>!t||typeof t.role!=='string'||typeof t.id!=='string'||!Number.isInteger(t.attempts)||t.attempts<0||!['completed','failed','blocked','cancelled'].includes(t.status))) throw new Error('Invalid terminal tasks');
      const observations=run.tasks.map(t=>({t,verified:reusable(t)}));
      terminalRuns++;
      for(const {t,verified} of observations) {
        let entry=profiles.get(t.role);
        if(!entry){entry={profile:{role:t.role,reviewed:0,unreviewed:0,failed:0,blocked:0,cancelled:0,runs:0,evidence:[],evidenceTruncated:false},runIds:new Set()};profiles.set(t.role,entry);}
        const p=entry.profile;
        if(t.status==='blocked'){p.blocked++;continue;}
        if(t.status==='cancelled'){p.cancelled++;continue;}
        const outcome=t.status==='failed'?'failed':verified?'reviewed':'unreviewed';
        p[outcome]++;entry.runIds.add(run.id);
        if(p.evidence.length<30)p.evidence.push({runId:run.id,taskId:t.id,outcome,attempts:t.attempts});else p.evidenceTruncated=true;
      }
    }catch{unreadable++;}
  }
  return {profiles:[...profiles.values()].map(({profile,runIds})=>({...profile,runs:runIds.size})).sort((a,b)=>a.role.localeCompare(b.role)),scanned:selected.length,terminalRuns,unreadable,truncated:names.filter(n=>n!==`${excludeRunId}.json`).length>selected.length,notice:'Project-local exact role labels; model/configuration and skill identity are not verified. Reviewed means accepted by an agent, not independently proven correct. No model calls.'};
}
/** Advisory only: preserve every task, dependency, contract and review. */
export async function teamAdvice(store:FileStore, plan:RunRecord) {
  const history=await teamProfiles(store,plan.id);
  const byRole=new Map(history.profiles.map(p=>[p.role,p]));
  return {runId:plan.id,status:plan.status,roles:[...new Set(plan.tasks.map(t=>t.role))].map(role=>{
    const p=byRole.get(role);
    const outcome=!p||history.truncated||history.unreadable||p.runs<3||p.reviewed+p.failed<3?'insufficient_evidence':p.failed>0?'inspect_failures':'reviewed_history_available';
    return {role,taskIds:plan.tasks.filter(t=>t.role===role).map(t=>t.id),outcome,history:p??null};
  }),scanned:history.scanned,unreadable:history.unreadable,truncated:history.truncated,notice:'No agent/model selected or plan altered. Role histories do not establish transferable skills; review evidence and actual task requirements before proposing any team changes.'};
}
