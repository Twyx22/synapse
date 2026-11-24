/** Advisory prioritization only. No execution, policy changes or model calls. */
import type { ImprovementKind, ImprovementProposal } from './evolution.ts';
const severity:Record<ImprovementKind,number>={contract_compliance:4,recovery:4,review_quality:3,late_delivery:3,review_latency:2,coordination:2,verification:2,measurement:1,team_feedback:1};
export function rankBacklog(proposals: ImprovementProposal[]) {
  return proposals.filter(p=>p.status!=='rejected').map(p=>({
    id:p.id,kind:p.kind,status:p.status,sourceRunId:p.sourceRunId,
    priority:severity[p.kind]??1, evidenceCount:p.evidence.length,
    nextAction:p.status==='ready_for_experiment'?'request_experiment_approval':p.status==='deliberating'?'inspect_incomplete_debate':'collect_evidence',
    updatedAt:p.updatedAt,
  })).sort((a,b)=>b.priority-a.priority||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}
