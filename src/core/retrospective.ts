import type { RunRecord, TaskRecord } from './types.ts';

/** Review is an agent opinion, not external validation. Do not expose failed or pending artifacts as accepted. */
export function reusable(task: TaskRecord): boolean {
  return task.status === 'completed' && task.review === true && !!task.reviewResult?.trim() && !!task.result?.trim() &&
    (!task.contract || (task.contractEvidence?.attempt === task.attempts && task.contractEvidence.missing?.length === 0));
}

/** Deterministic retrospective over retained evidence. No model calls, edits, or policy changes. */
export function retrospective(run: RunRecord) {
  const tasks = run.tasks.map(t => ({taskId:t.id,status:t.status,attempts:t.attempts,
    reviewedResultReusable:reusable(t), dependsOn:t.dependsOn,
    blockedBy:t.dependsOn.filter(id=>['failed','blocked','cancelled'].includes(run.tasks.find(d=>d.id===id)?.status ?? '')),
    contractMissingCount:t.contractEvidence?.missing?.length ?? null,
    events:run.events.filter(e=>e.taskId===t.id).slice(-12).map(e=>({id:e.id,type:e.type,at:e.at}))}));
  const direct=run.messages.filter(m=>m.to!=='all'&&m.to!=='coordinator');
  const findings:{kind:string;count:number;taskIds?:string[];messageIds?:string[]}[]=[];
  const addTasks=(kind:string,ids:string[])=>{if(ids.length)findings.push({kind,count:ids.length,taskIds:ids});};
  const addMessages=(kind:string,ids:string[])=>{if(ids.length)findings.push({kind,count:ids.length,messageIds:ids});};
  addTasks('failed_tasks',tasks.filter(t=>t.status==='failed').map(t=>t.taskId));
  addTasks('blocked_tasks',tasks.filter(t=>t.status==='blocked').map(t=>t.taskId));
  addTasks('retry_tasks',tasks.filter(t=>t.attempts>1).map(t=>t.taskId));
  addTasks('contract_violations',tasks.filter(t=>(t.contractMissingCount??0)>0).map(t=>t.taskId));
  addMessages('late_messages',direct.filter(m=>['completed','failed','blocked','cancelled'].includes(m.recipientStatusAtSend??'')).map(m=>m.id));
  addMessages('retrieval_not_observed',direct.filter(m=>!Object.hasOwn(m.fetchedBy??{},m.to)).map(m=>m.id));
  addMessages('team_improvement_feedback',run.messages.filter(m=>m.type==='improvement').map(m=>m.id));
  return {runId:run.id,status:run.status, tasks, findings,
    reusableTaskIds:['completed','failed'].includes(run.status)?tasks.filter(t=>t.reviewedResultReusable).map(t=>t.taskId):[],
    notice:'Retained evidence only. Reviews are opinions; reverify against current project. Missing retrieval evidence is not proof of unread messages. Failed dependencies stay blocked. No actions or model calls performed.'};
}
