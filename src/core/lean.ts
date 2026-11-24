import { SynapseError, type ExactVerification, type RunRecord, type TaskRecord } from './types.ts';
/** Conservative bound for the shipped adapter: one worker plus up to two reviewer sessions per attempt. */
export function sessionEnvelope(tasks: Pick<TaskRecord,'maxAttempts'|'review'>[]) {
  return tasks.reduce((sum,t)=>sum+t.maxAttempts*(t.review?3:1),0);
}
export function assertSessionBudget(bound:number,budget?:number) {
  if (budget === undefined) return;
  if (!Number.isSafeInteger(budget)||budget<1||budget>576||!Number.isSafeInteger(bound)||bound<1||bound>budget) throw new SynapseError('Graph session budget insufficient or invalid; revise the plan explicitly');
}
export function exactCheck(spec:ExactVerification,text:string) {
  return spec.kind==='exact' && text.trim()===spec.expected.trim();
}
/** No automatic routing or model calls. Exact verification does not establish general correctness. */
export function leanAdvice(run:RunRecord) {
  const tasks=run.tasks.map(t=>({taskId:t.id,toolProfile:t.toolProfile??"standard",verification:t.verification?'exact_fixture':'none',independentReview:t.review,
    maxGraphSessions:t.maxAttempts*(t.review?3:1), exactOutcome:t.verificationEvidence?.attempt===t.attempts ? t.verificationEvidence.passed?'passed':'failed':'not_observed',
    exactOnly:t.verification?.kind==='exact'&&!t.review}));
  return {schema:1,runId:run.id,sessionBudget:run.options.sessionBudget??null,maxGraphSessions:sessionEnvelope(run.tasks),
    scope:'Planned graph sessions with shipped adapter only; excludes coordinator, council, other instances and provider calls.',
    advisoryOnly:true,tasks, guidance:'Keep required reviews and contracts. Use exact fixtures only when explicitly authorized and objectively sufficient; no automatic change to plan or permissions.'};
}
