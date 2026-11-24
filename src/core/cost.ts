/** Usage reported by OpenCode, not invoices. No provider calls or content retained. */
export const usageKeys = ['inputTokens','outputTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens','reportedCostUsd'] as const;
type UsageKey = typeof usageKeys[number];
type Usage = Partial<Record<UsageKey,number>>;
type Source = 'session_get'|'context_partial'|'unavailable';
export type UsageSnapshot = Usage & { usageSource: Source; observedSteps?: number };
const obj = (v:unknown):Record<string,unknown>|undefined => v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const metric = (v:unknown,key:UsageKey):v is number => typeof v==='number'&&Number.isFinite(v)&&v>=0&&(key==='reportedCostUsd'?v<=Number.MAX_SAFE_INTEGER:Number.isSafeInteger(v));
function parse(v:unknown):Usage {
  const row=obj(v),t=obj(row?.tokens),cache=obj(t?.cache);
  const raw = [t?.input,t?.output,t?.reasoning,cache?.read,cache?.write,row?.cost];
  const result:Usage={};
  usageKeys.forEach((k,i)=>{const n=raw[i];if(metric(n,k))result[k]=n;});
  return result;
}
export function sessionUsage(value:unknown,sessionID:string):UsageSnapshot {
  const row=obj(value);
  if(row?.id!==sessionID)return {usageSource:'unavailable'};
  const usage=parse(row);
  return {...usage,usageSource:Object.keys(usage).length?'session_get':'unavailable'};
}
/** Context may be pruned; never present its sums as full-session totals. Duplicate IDs are counted once. */
export function contextUsage(messages:readonly unknown[]):UsageSnapshot {
  const seen=new Set<string>(); const totals:Usage={}; const coverage:Partial<Record<UsageKey,number>>={};let steps=0;
  for(const item of messages){
    const row=obj(item),info=obj(row?.info)??row;
    if(!info||!['assistant','compaction'].includes(String(info.role??info.type)))continue;
    const id=info.id;
    if(typeof id!=='string'||!id||seen.has(id))continue;
    seen.add(id);steps++;
    const usage=parse(info);
    for(const k of usageKeys){const v=usage[k];if(v!==undefined){totals[k]=(totals[k]??0)+v;coverage[k]=(coverage[k]??0)+1;}}
  }
  // If a visible step is missing a metric, don't report a misleading total for that metric.
  for(const k of usageKeys)if(coverage[k]!==steps||!metric(totals[k],k))delete totals[k];
  return {...totals,observedSteps:steps,usageSource:Object.keys(totals).length?'context_partial':'unavailable'};
}
type Role='worker'|'review'|'council'|'unknown';
type Sample={role:Role; usage:UsageSnapshot; settled:boolean};
function group(samples:Sample[]){
  const metrics=Object.fromEntries(usageKeys.map(k=>{
    const values=samples.filter(s=>metric(s.usage[k],k));
    const sum=values.reduce((a,s)=>a+s.usage[k]!,0);
    const settledAggregate=values.filter(s=>s.settled&&s.usage.usageSource==='session_get').length;
    return [k,{observed:values.length&&metric(sum,k)?sum:null,coveredSessions:values.length,settledAggregateSessions:settledAggregate,completeForRetainedSessions:samples.length>0&&settledAggregate===samples.length&&metric(sum,k)}];
  })) as Record<UsageKey,{observed:number|null;coveredSessions:number;settledAggregateSessions:number;completeForRetainedSessions:boolean}>;
  return {sessions:samples.length,aggregateSnapshots:samples.filter(s=>s.usage.usageSource==='session_get').length,partialSnapshots:samples.filter(s=>s.usage.usageSource==='context_partial').length,missingSnapshots:samples.filter(s=>s.usage.usageSource==='unavailable').length,metrics};
}
/** Only retained logs are in scope. Session IDs are deduplicated; latest snapshot replaces previous. */
export function summarizeCosts(raw:string,runId?:string,budgetUsd?:number){
  if(budgetUsd!==undefined&&(!Number.isFinite(budgetUsd)||budgetUsd<0))throw new Error('Budget must be finite and non-negative');
  const sessions=new Map<string,Sample>();
  for(const line of raw.split('\n'))try{
    const entry=JSON.parse(line),f=obj(entry.fields);
    if(!f||typeof f.sessionId!=='string'||typeof f.runId!=='string'||(runId&&f.runId!==runId))continue;
    if(!['agent.session.created','agent.prompt.started','agent.usage.snapshot'].includes(entry.event))continue;
    const key=JSON.stringify([f.runId,f.sessionId]);
    const previous=sessions.get(key)??{role:'unknown',usage:{usageSource:'unavailable'},settled:false} as Sample;
    if(f.role==='worker'||f.role==='review'||f.role==='council')previous.role=f.role;
    if(entry.event==='agent.usage.snapshot'){
      const source=f.usageSource;
      const usage:UsageSnapshot={usageSource:source==='session_get'||source==='context_partial'?source:'unavailable'};
      if(usage.usageSource!=='unavailable')for(const k of usageKeys){const v=f[k];if(metric(v,k))usage[k]=v;}
      previous.usage=usage;previous.settled=f.settled===true;
    }
    sessions.set(key,previous);
  }catch{/* malformed retained log record */}
  const samples=[...sessions.values()];const total=group(samples);
  const byRole={worker:group(samples.filter(s=>s.role==='worker')),review:group(samples.filter(s=>s.role==='review')),council:group(samples.filter(s=>s.role==='council')),unknown:group(samples.filter(s=>s.role==='unknown'))};
  const cost=total.metrics.reportedCostUsd,review=byRole.review.metrics.reportedCostUsd;
  const reviewShare=cost.completeForRetainedSessions&&byRole.unknown.sessions===0&&cost.observed!==null&&cost.observed>0? (review.observed??0)/cost.observed:null;
  return {schema:1,scope:'retained_synapse_session_logs_only',runId:runId??null,currency:'USD',billingVerified:false,coverageNote:'Not a full project/provider bill. Rotated logs, coordinator calls and unobserved usage are excluded. Zero is a reported value, not proof of free use. Token buckets are separate; do not sum overlapping categories.',total,byRole,reviewShareOfReportedCost:reviewShare,
    budget:budgetUsd===undefined?null:{limitUsd:budgetUsd,advisoryOnly:true,status:cost.observed!==null&&cost.observed>budgetUsd?'observed_over_limit':cost.completeForRetainedSessions?'observed_within_limit_not_verified':'insufficient_coverage'}};
}

/** Metadata of visible assistant/compaction messages, not a guaranteed count of provider calls. */
export function visibleStepProfile(messages:readonly unknown[]){
  const seen=new Set<string>();const steps:Usage[]=[];
  for(const item of messages){const row=obj(item),info=obj(row?.info)??row;if(!info||!['assistant','compaction'].includes(String(info.role??info.type)))continue;
    const id=info.id;if(typeof id!=='string'||!id||seen.has(id))continue;seen.add(id);
    if(steps.length<256)steps.push(parse(info));
  }
  return {visibleSteps:seen.size,truncated:seen.size>steps.length,steps};
}
