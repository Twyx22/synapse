import { CostLedger } from "./ledger.ts";
import { DiagnosticLogger } from "./diagnostics.ts";
import { economicPair } from "./economics.ts";
/** Local, advisory paired experiments. Never schedules runs, changes policies, or invokes models. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "./store.ts";
import { SynapseError, type RunRecord } from "./types.ts";
import { topology } from "./topology.ts";
import { inspectIsolation } from "./isolation.ts";
import { VERSION } from "./version.ts";

export interface ExperimentPair { baselineRunId: string; candidateRunId: string }
export interface ExpectedResult { taskId: string; text: string }
interface Experiment {
  schema: 1; id: string; createdAt: string; version: string; proposalId?: string;
  pairs: ExperimentPair[]; planDigest: string; baselineConcurrency: number; candidateConcurrency: number;
  expected: ExpectedResult[]; modelLabel: string;
}
const idPattern = /^experiment_[a-f0-9-]{36}$/;
const runPattern = /^run_[a-f0-9-]{36}$/;
const median = (values: number[]) => { const sorted = [...values].sort((a,b)=>a-b); const n = sorted.length; return n ? (sorted[Math.floor((n-1)/2)] + sorted[Math.floor(n/2)])/2 : null; };
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
function canonical(v:unknown):unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));
  return v;
}
/** Do not ignore task order, reviews, deadlines, retries, contracts or instructions. */
function fingerprint(run:RunRecord) {
  return hash(JSON.stringify(canonical({objective:run.objective, maxEvents:run.options.maxEvents,maxMessages:run.options.maxMessages,sessionBudget:run.options.sessionBudget,
    tasks:run.tasks.map(t=>({id:t.id,title:t.title,instruction:t.instruction,role:t.role,dependsOn:t.dependsOn,priority:t.priority,review:t.review,maxAttempts:t.maxAttempts,timeoutSeconds:t.timeoutSeconds,contract:t.contract,patch:t.patch,verification:t.verification,toolProfile:t.toolProfile}))})));
}
function pristine(run:RunRecord) {
  return run.status==="planned" && run.events.length===0 && run.messages.length===0 && run.tasks.every(t=>t.status==="pending"&&t.attempts===0&&!t.result&&!t.contractEvidence&&!t.verificationEvidence);
}
const fail = (s:string):never => { throw new SynapseError(s); };
function publicRecord(exp:Experiment) {
  return {id:exp.id,createdAt:exp.createdAt,version:exp.version,proposalId:exp.proposalId,pairs:exp.pairs.map(p=>({baselineRunId:p.baselineRunId,candidateRunId:p.candidateRunId})),
    baselineConcurrency:exp.baselineConcurrency,candidateConcurrency:exp.candidateConcurrency,expectedTaskCount:exp.expected.length};
}
export class ExperimentStore {
  readonly directory:string;
  readonly store:FileStore;
  constructor(store:FileStore) { this.store=store; this.directory=join(store.directory,"experiments"); }
  private path(id:string) { if(!idPattern.test(id)) fail("Invalid experiment ID"); return join(this.directory,`${id}.json`); }
  private async read(id:string):Promise<Experiment> {
    const e=JSON.parse(await readFile(this.path(id),"utf8")) as Experiment;
    if(e.id!==id||e.schema!==1||!Array.isArray(e.pairs)||!Array.isArray(e.expected)) fail("Invalid experiment document");
    return e;
  }
  async list() {
    const names=(await readdir(this.directory).catch(()=>[])).filter(n=>idPattern.test(n.slice(0,-5))&&n.endsWith(".json")).sort();
    const records=[];
    for(const name of names) { try {records.push(publicRecord(await this.read(name.slice(0,-5))));} catch {/* ignore corrupt registration in listing */} }
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async isRegistered(runId:string) {
    return (await this.list()).some(e=>e.pairs.some(p=>p.baselineRunId===runId||p.candidateRunId===runId));
  }
  async register(pairs:ExperimentPair[],expected:ExpectedResult[],modelLabel:string,proposalId?:string) {
    if(!Array.isArray(pairs)||pairs.length<1||pairs.length>5) fail("Register 1-5 pairs before executing them");
    if(typeof modelLabel!=="string"||!modelLabel.trim()||modelLabel.length>200) fail("Provide the model/configuration label for all runs");
    if(proposalId!==undefined&&!/^idea_[a-f0-9-]{36}$/.test(proposalId)) fail("Invalid linked proposal ID");
    const ids=pairs.flatMap(p=>[p?.baselineRunId,p?.candidateRunId]);
    if(ids.some(id=>typeof id!=="string"||!runPattern.test(id))||new Set(ids).size!==ids.length) fail("Run IDs must be valid and distinct across all pairs");
    const runs=await Promise.all(ids.map(id=>this.store.read(id)));
    const baseline=runs[0],candidate=runs[1],digest=fingerprint(baseline);
    if(baseline.options.concurrency===candidate.options.concurrency) fail("Vary concurrency only; baseline and candidate must differ");
    if(runs.some((r,i)=>!pristine(r)||fingerprint(r)!==digest||r.options.concurrency!==(i%2?candidate:baseline).options.concurrency||r.tasks.some(t=>t.patch))) fail("All runs must be fresh, identical read-only plans except concurrency");
    if(!Array.isArray(expected)||expected.length!==baseline.tasks.length||new Set(expected.map(e=>e?.taskId)).size!==expected.length||expected.some(e=>!e||!baseline.tasks.some(t=>t.id===e.taskId)||typeof e.text!=="string"||!e.text.trim()||e.text.length>2000)) fail("Provide one exact expected text per task (1-2000 characters)");
    // No answers are injected into agent prompts. Registration is immutable, local and private.
    const record:Experiment={schema:1,id:`experiment_${randomUUID()}`,createdAt:new Date().toISOString(),version:VERSION,
      proposalId,pairs:pairs.map(p=>({baselineRunId:p.baselineRunId,candidateRunId:p.candidateRunId})),planDigest:digest,baselineConcurrency:baseline.options.concurrency,candidateConcurrency:candidate.options.concurrency,
      expected:expected.map(e=>({taskId:e.taskId,text:e.text})),modelLabel:modelLabel.trim()};
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const destination=this.path(record.id),temp=`${destination}.${randomUUID()}.tmp`;
    try {await writeFile(temp,JSON.stringify(record,null,2),{flag:"wx",mode:0o600}); await rename(temp,destination);}
    finally {await unlink(temp).catch(()=>undefined);}
    return publicRecord(record);
  }
  private async measure(id:string,exp:Experiment,concurrency:number) {
    try {
      const run=await this.store.read(id);
      if(fingerprint(run)!==exp.planDigest||run.options.concurrency!==concurrency) return {runId:id,status:"invalid",reason:"plan changed",wallMs:null,qualityPass:false};
      const starts=run.events.filter(e=>e.type==="run.started"), finishes=run.events.filter(e=>e.type==="run.finished");
      const cancelled=run.status==="cancelled";
      if(!["completed","failed","cancelled"].includes(run.status)) return {runId:id,status:"pending",reason:"not terminal",wallMs:null,qualityPass:false};
      const start=Date.parse(starts[0]?.at??""),finish=Date.parse(finishes[0]?.at??"");
      // No resumed/interrupted runs, missing timings, or overlap within a pair for comparisons.
      const validTime=starts.length===1&&finishes.length===1&&Number.isFinite(start)&&Number.isFinite(finish)&&finish>start&&start>=Date.parse(exp.createdAt)&&!run.events.some(e=>["run.interrupted","task.recovered"].includes(e.type));
      const exactMatches=exp.expected.filter(e=>run.tasks.find(t=>t.id===e.taskId)?.result?.trim()===e.text.trim()).length;
      const contractFailures=run.tasks.filter(t=>t.contract&&(!t.contractEvidence||t.contractEvidence.attempt!==t.attempts||!Array.isArray(t.contractEvidence.missing)||t.contractEvidence.missing.length>0)).length;
      const missingReviews=run.tasks.filter(t=>t.review&&(!run.events.some(e=>e.taskId===t.id&&e.type==="task.verified")||t.status!=="completed")).length;
      const missingExactChecks=run.tasks.filter(t=>t.verification&&(!t.verificationEvidence?.passed||t.verificationEvidence.attempt!==t.attempts)).length;
      const qualityPass=run.status==="completed"&&run.tasks.every(t=>t.status==="completed")&&exactMatches===exp.expected.length&&!contractFailures&&!missingReviews&&!missingExactChecks;
      return {runId:id,status:cancelled?"cancelled":validTime?"measured":"invalid",runStatus:run.status,
        reason:validTime?undefined:"missing, interrupted, or invalid timing",wallMs:validTime?finish-start:null,
        startAt:validTime?start:undefined,finishAt:validTime?finish:undefined,qualityPass,exactMatches,expectedCount:exp.expected.length,
        contractFailures,missingReviews,missingExactChecks,attempts:run.tasks.reduce((n,t)=>n+t.attempts,0)};
    }catch{return {runId:id,status:"invalid",reason:"run unreadable",wallMs:null,qualityPass:false};}
  }
  async evaluate(id:string) {
    const exp=await this.read(id);
    const pairs=await Promise.all(exp.pairs.map(async p=>{
      const baseline=await this.measure(p.baselineRunId,exp,exp.baselineConcurrency),candidate=await this.measure(p.candidateRunId,exp,exp.candidateConcurrency);
      const overlap=baseline.startAt!==undefined&&candidate.startAt!==undefined&&baseline.startAt<candidate.finishAt!&&candidate.startAt<baseline.finishAt!;
      const comparable=baseline.status==="measured"&&candidate.status==="measured"&&!overlap;
      const gain=comparable&&baseline.qualityPass&&candidate.qualityPass&&baseline.wallMs!==null&&candidate.wallMs!==null?(baseline.wallMs-candidate.wallMs)/baseline.wallMs:null;
      return {baseline,candidate,overlap,comparable,gain};
    }));
    // All registered pairs count; never discard failed cases to generate a positive recommendation.
    const allMeasures=pairs.flatMap(p=>[p.baseline,p.candidate]).filter(m=>m.startAt!==undefined&&m.finishAt!==undefined).sort((a,b)=>a.startAt!-b.startAt!);
    const crossRunOverlap=allMeasures.some((m,i)=>i>0&&allMeasures[i-1].finishAt!>m.startAt!);
    const isolation=await inspectIsolation(this.store,new Set(exp.pairs.flatMap(p=>[p.baselineRunId,p.candidateRunId])),allMeasures.map(m=>({startAt:m.startAt!,finishAt:m.finishAt!})));
    const gains=pairs.flatMap(p=>p.gain===null?[]:[p.gain]);
    const medianGain=median(gains);
    const pending=pairs.some(p=>p.baseline.status==="pending"||p.candidate.status==="pending");
    const valid=pairs.every(p=>p.comparable)&&!crossRunOverlap&&isolation.status==="no_local_overlap_observed";
    const allQuality=pairs.every(p=>p.baseline.qualityPass&&p.candidate.qualityPass);
    const status=pending?"pending":!valid?"inconclusive":!allQuality?"quality_gate_failed":pairs.length<3?"insufficient_pairs":medianGain!==null&&medianGain>=0.10&&gains.every(g=>g>=0)?"candidate_promising":"no_consistent_gain";
    const ledger=new CostLedger(this.store.directory);
    // Use durable observations plus retained logs, keeping all registered pairs.
    const raw=await new DiagnosticLogger(join(this.store.directory,"diagnostics")).recent();
    const economics=await Promise.all(pairs.map(async p=>({baselineRunId:p.baseline.runId,candidateRunId:p.candidate.runId,...economicPair(await ledger.summary(raw,p.baseline.runId),await ledger.summary(raw,p.candidate.runId),valid&&allQuality)})));
    return {...publicRecord(exp),status,pairs,crossRunOverlap,isolation,medianPairedGain:medianGain,allQuality,economics,
      guidance:status==="candidate_promising"?"Recommend human review for this fixture only; never adopt automatically.":"No strategy change recommended.",
      limitations:"Exact trimmed text is a fixture check, not general correctness. Model/configuration label is self-reported, local overlap checked against retained run records only; other processes, projects, council sessions, provider load and environment uncontrolled; at least 3 pairs and 10% median gain with no slower pair required. No significance, token/cost or generalization claim. Never changes policy."};
  }
  /** Advisory only. Requires an exact fixture and the same self-reported model/configuration label. */
  async advise(runId:string,modelLabel:string) {
    if(typeof modelLabel!=="string"||!modelLabel.trim()||modelLabel.length>200) fail("Provide the model/configuration label");
    const run=await this.store.read(runId),digest=fingerprint(run),currentConcurrency=run.options.concurrency;
    const matches=[];
    for(const item of await this.list()) {
      const exp=await this.read(item.id);
      if(exp.planDigest!==digest||exp.modelLabel!==modelLabel.trim()||exp.baselineConcurrency!==currentConcurrency) continue;
      const outcome=await this.evaluate(exp.id);
      matches.push({experimentId:exp.id,version:exp.version,candidateConcurrency:exp.candidateConcurrency,status:outcome.status,medianPairedGain:outcome.medianPairedGain,pairCount:exp.pairs.length});
    }
    const current=matches.filter(m=>m.version===VERSION);
    const candidates=[...new Set(current.map(m=>m.candidateConcurrency))].filter(c=>current.filter(m=>m.candidateConcurrency===c).every(m=>m.status==="candidate_promising"));
    // Conflicting, incomplete or older evidence cannot justify an automatic change.
    const graph=topology(run);
    const suggested=candidates.length===1?candidates[0]:null;
    return {runId,currentConcurrency,graph,suggestedConcurrency:suggested,status:suggested===null?"keep_current":"advisory_candidate",matches,
      guidance:suggested===null?"Keep the existing plan; evidence is insufficient, mixed, or from another version.":"Consider this candidate for the identical fixture only, with user approval; no settings changed.",
      limitations:"Exact plan/model-label matching only. No generalization, no automatic execution, no review or permission changes."};
  }

}
