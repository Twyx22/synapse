/** Advisory only: separate token categories, no implied prices or cache discount. */
import type { CostLedger } from './ledger.ts';
import type { RunRecord } from './types.ts';
import { topology } from './topology.ts';
type Summary=Awaited<ReturnType<CostLedger['summary']>>;
export function economicAdvice(run:RunRecord, summary:Summary) {
  const graph=topology(run), m=summary.total.metrics;
  const clean=!summary.ledger.invalidRecords&&!summary.ledger.unavailable&&!summary.ledger.retainedWriteErrors&&!summary.ledger.unfinished;
  const input=m.inputTokens, cache=m.cacheReadTokens;
  const functionalEligible=run.status==='completed';
  const complete=clean&&input.completeForRetainedSessions&&summary.byRole.unknown.sessions===0;
  // Conservative lower bound; does not prove that every historic request was retained.
  const minimumWorkerSessions=run.tasks.reduce((n,t)=>n+t.attempts,0);
  const minimumReviewSessions=run.tasks.filter(t=>t.status==='completed'&&t.review).length;
  const sessionCoverage=summary.byRole.worker.sessions>=minimumWorkerSessions&&summary.byRole.review.sessions>=minimumReviewSessions;
  const eligible=functionalEligible&&complete&&sessionCoverage&&summary.total.sessions>0&&input.observed!==null;
  const profiles=summary.profiling.sessions;
  const fullyProfiled=complete&&summary.profiling.detailsOmitted===0&&profiles.length===summary.total.sessions&&profiles.length>0&&profiles.every(p=>p.steps&&p.steps.length>0&&!p.truncated&&p.steps.length===p.visibleSteps&&p.steps.every(s=>s.inputTokens!==undefined)&&p.settledAggregateInput!==null&&p.steps.reduce((n,s)=>n+s.inputTokens!,0)===p.settledAggregateInput);
  const profiledInput=fullyProfiled?profiles.reduce((n,p)=>n+p.steps!.reduce((a,s)=>a+s.inputTokens!,0),0):null;
  const firstInput=fullyProfiled?profiles.reduce((n,p)=>n+p.steps![0].inputTokens!,0):null;
  const reconciled=profiledInput!==null&&profiledInput===input.observed;
  const firstStepShare=reconciled&&profiledInput>0?firstInput!/profiledInput:null;
  const reviewShare=complete?summary.reviewShareOfInputTokens:null;
  const findings:string[]=[];
  if(!functionalEligible)findings.push('run_not_completed_no_performance_recommendation');
  else if(!eligible)findings.push('incomplete_economic_coverage_no_performance_recommendation');
  if(graph.concurrencyAboveWidth)findings.push('concurrency_above_dag_width');
  if(!complete)findings.push('incomplete_input_accounting');
  if(eligible&&firstStepShare!==null&&firstStepShare>=0.8)findings.push('first_visible_step_input_dominant');
  if(eligible&&reviewShare!==null&&reviewShare>=0.5)findings.push('review_input_dominant');
  if(clean&&m.reportedCostUsd.completeForRetainedSessions&&m.reportedCostUsd.observed===0)findings.push('reported_zero_not_billing_evidence');
  if(!reconciled)findings.push('step_profile_not_reconciled');
  return {schema:1,runId:run.id,advisoryOnly:true,functionalEligible,economicEligible:eligible,performanceEligible:eligible,sessionCoverage:{minimumWorkerSessions,minimumReviewSessions,minimumObserved:sessionCoverage,scope:"lower_bound_not_full_billing_coverage"},graph,runStatus:run.status,accountingClean:clean,completeInputForObservedSessions:complete,observedInputTokens:input.observed,observedCacheReadTokens:cache.observed,completeCacheForObservedSessions:clean&&cache.completeForRetainedSessions,profileReconciled:reconciled,firstVisibleStepInputShare:firstStepShare,reviewInputShare:reviewShare,findings,
    guidance:!functionalEligible?'Run not completed. Usage is descriptive only; do not infer savings or recommend a strategy from this run.':!eligible?'Input usage coverage is insufficient. Do not infer savings or recommend performance changes.':'Inspect initial context and tool descriptions when first-step input dominates. Cache reads are separate metrics, not proven savings. For a new plan, avoid needless agents; preserve all requested reviews, contracts and permissions. No automatic changes or model calls.',billingVerified:false};
}
export function economicPair(b:Summary,c:Summary,qualityAndIsolation:boolean) {
  const valid=(s:Summary)=>s.total.sessions>0&&s.byRole.unknown.sessions===0&&!s.ledger.unavailable&&!s.ledger.invalidRecords&&!s.ledger.retainedWriteErrors&&!s.ledger.unfinished;
  const metric=(key:'inputTokens'|'cacheReadTokens'|'outputTokens'|'reasoningTokens'|'reportedCostUsd')=>{
    const a=b.total.metrics[key],z=c.total.metrics[key];
    const comparable=qualityAndIsolation&&valid(b)&&valid(c)&&a.completeForRetainedSessions&&z.completeForRetainedSessions&&a.observed!==null&&z.observed!==null;
    return {baseline:a.observed,candidate:z.observed,comparable,relativeReduction:comparable&&a.observed!>0?(a.observed!-z.observed!)/a.observed!:null};
  };
  return {input:metric('inputTokens'),cacheRead:metric('cacheReadTokens'),output:metric('outputTokens'),reasoning:metric('reasoningTokens'),reportedUsd:metric('reportedCostUsd'),billingVerified:false};
}
