/** Durable, numeric-only session observations. Never a provider bill. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeCosts, usageKeys, type UsageSnapshot, visibleStepProfile } from './cost.ts';

type Identity={runId:string;sessionId:string;role:'worker'|'review'|'council'};
type Profile=ReturnType<typeof visibleStepProfile>;
type RecordEntry=Identity & {schema:1;phase:'start'|'finish';settled?:boolean;usage?:UsageSnapshot;profile?:Profile;promptChars?:number};
const key=(r:Identity)=>createHash('sha256').update(JSON.stringify([r.runId,r.sessionId])).digest('hex');
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[\w.-]{1,150}$/.test(v);
const number=(v:unknown,cost=false):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&(cost?v<=Number.MAX_SAFE_INTEGER:Number.isSafeInteger(v));
function clean(raw:unknown):RecordEntry {
  const r=raw as RecordEntry;
  if(!r||r.schema!==1||!validId(r.runId)||!validId(r.sessionId)||!['worker','review','council'].includes(r.role)||!['start','finish'].includes(r.phase))throw new Error('Invalid ledger record');
  const out:RecordEntry={schema:1,runId:r.runId,sessionId:r.sessionId,role:r.role,phase:r.phase};
  if(r.phase==='finish'){
    out.settled=r.settled===true;
    const source=r.usage?.usageSource;
    out.usage={usageSource:source==='session_get'||source==='context_partial'?source:'unavailable'};
    if(out.usage.usageSource!=='unavailable')for(const k of usageKeys){const v=r.usage?.[k];if(number(v,k==='reportedCostUsd'))out.usage[k]=v;}
    if(number(r.promptChars))out.promptChars=r.promptChars;
    if(r.profile&&Array.isArray(r.profile.steps)&&r.profile.steps.length<=256&&number(r.profile.visibleSteps)&&r.profile.visibleSteps>=r.profile.steps.length){
      out.profile={visibleSteps:r.profile.visibleSteps,truncated:r.profile.truncated===true||r.profile.visibleSteps>r.profile.steps.length,steps:r.profile.steps.map(s=>{const v:Partial<Record<typeof usageKeys[number],number>>={};for(const k of usageKeys)if(number(s?.[k],k==='reportedCostUsd'))v[k]=s[k];return v;})};
    }
  }
  return out;
}
export class CostLedger {
  readonly directory:string;
  constructor(dataDirectory:string){this.directory=join(dataDirectory,'cost-ledger');}
  private async check(create=false){
    if(create)await mkdir(this.directory,{recursive:true,mode:0o700});
    const s=await lstat(this.directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw new Error('Unsafe cost ledger directory');
  }
  private async write(raw:RecordEntry){
    const r=clean(raw);await this.check(true);const path=join(this.directory,`${key(r)}-${r.phase}.json`),tmp=`${path}.${randomUUID()}.tmp`;
    const f=await open(tmp,'wx',0o600);
    try {try{await f.writeFile(JSON.stringify(r));await f.sync();}finally{await f.close();}try{await link(tmp,path);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=await this.read(path);if(JSON.stringify(old)!==JSON.stringify(r))throw new Error('Conflicting session ledger record');}}
    finally{await unlink(tmp).catch(()=>undefined);}
  }
  private async read(path:string){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.size>128_000)throw new Error('Invalid ledger file');return clean(JSON.parse(await f.readFile('utf8')));}finally{await f.close();}}
  start(id:Identity){return this.write({...id,schema:1,phase:'start'});}
  finish(id:Identity,settled:boolean,usage:UsageSnapshot,promptChars:number,profile?:Profile){return this.write({...id,schema:1,phase:'finish',settled,usage,promptChars,profile});}
  async summary(raw:string,runId?:string,budgetUsd?:number){
    const starts=new Map<string,RecordEntry>(),finishes=new Map<string,RecordEntry>();let invalid=0,unavailable=false;
    try{
      await this.check();const names=(await readdir(this.directory)).filter(n=>/^[a-f0-9]{64}-(start|finish)\.json$/.test(n)).sort();
      for(const n of names){try{const r=await this.read(join(this.directory,n));if(n!==`${key(r)}-${r.phase}.json`)throw new Error('Identity mismatch');if(!runId||r.runId===runId)(r.phase==='start'?starts:finishes).set(key(r),r);}catch{invalid++;}}
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')unavailable=true;}
    const event=(event:string,fields:object)=>JSON.stringify({event,fields});
    // Starts first, legacy logs next, durable final observations last. Never sum the same session twice.
    const lines=[...starts.values()].map(r=>event('agent.session.created',{runId:r.runId,sessionId:r.sessionId,role:r.role}));
    lines.push(raw);
    for(const r of finishes.values())lines.push(event('agent.usage.snapshot',{runId:r.runId,sessionId:r.sessionId,role:r.role,settled:r.settled,...r.usage}));
    const out=summarizeCosts(lines.join('\n'),runId,budgetUsd);
    const profiles=[...finishes.values()].filter(r=>r.profile!==undefined);
    let writeErrors=0;
    for(const line of raw.split('\n'))try{const e=JSON.parse(line);if(e.event==='agent.ledger.write_error'&&(!runId||e.fields?.runId===runId))writeErrors++;}catch{/* ignored */}
    const input=out.total.metrics.inputTokens,reviewInput=out.byRole.review.metrics.inputTokens;
    const reviewShareOfInputTokens=input.completeForRetainedSessions&&out.byRole.unknown.sessions===0&&input.observed!==null&&input.observed>0?(reviewInput.observed??0)/input.observed:null;
    return {...out,schema:2,scope:'persistent_session_ledger_and_retained_logs',coverageNote:'Not a provider bill. Pre-ledger rotated logs, coordinator calls and unobserved usage are excluded. Visible message steps may not equal API requests. Zero does not prove free use. Token categories may overlap.',ledger:{started:starts.size,finished:finishes.size,unfinished:[...starts.keys()].filter(k=>!finishes.has(k)).length,invalidRecords:invalid,unavailable,retainedWriteErrors:writeErrors},reviewShareOfInputTokens,profiling:{sessionsWithVisibleProfile:profiles.length,visibleSteps:profiles.reduce((s,r)=>s+r.profile!.visibleSteps,0),sessionsWithInputMetrics:profiles.filter(r=>r.profile!.steps.some(s=>s.inputTokens!==undefined)).length,detailsOmitted:Math.max(0,finishes.size-100),sessions:[...finishes.values()].slice(0,100).map(r=>({role:r.role,settledAggregateInput:r.settled&&r.usage?.usageSource==='session_get'?r.usage.inputTokens??null:null,promptChars:r.promptChars??null,visibleSteps:r.profile?.visibleSteps??null,truncated:r.profile?.truncated??null,steps:r.profile?.steps??null}))},
      budget:(invalid||unavailable||writeErrors)&&out.budget&&out.budget.status!=='observed_over_limit'?{...out.budget,status:'insufficient_coverage'}:out.budget};
  }
}
