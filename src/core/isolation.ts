/** Conservative detection of overlapping local graph executions from retained run records. */
import { readdir } from "node:fs/promises";
import { FileStore } from "./store.ts";
import type { RunRecord } from "./types.ts";
export type Interval = {startAt:number;finishAt:number};
function history(run:RunRecord): {intervals:Interval[]; uncertain:boolean} {
  let start:number|undefined; const intervals:Interval[]=[]; let uncertain=false;
  for (const e of run.events) {
    if (!["run.started","run.finished","run.interrupted","run.cancelled"].includes(e.type)) continue;
    const at=Date.parse(e.at);
    if (!Number.isFinite(at)) {uncertain=true;continue;}
    if(e.type==="run.started") {if(start!==undefined) uncertain=true; start=at;}
    else if(start!==undefined) {if(at<start) uncertain=true;else intervals.push({startAt:start,finishAt:at});start=undefined;}
    else if(e.type!=="run.cancelled" || run.tasks.some(t=>t.attempts>0)) uncertain=true;
  }
  if(start!==undefined) {if(run.status!=="running") uncertain=true; intervals.push({startAt:start,finishAt:Infinity});}
  if(run.status==="running"&&start===undefined) uncertain=true;
  if(run.tasks.some(t=>t.attempts>0)&&!intervals.length) uncertain=true;
  if(run.events.length>=run.options.maxEvents) uncertain=true;
  return {intervals,uncertain};
}
export async function inspectIsolation(store:FileStore, included:Set<string>, windows:Interval[]) {
  const overlappingRunIds:string[]=[];const uncertainRunIds:string[]=[];
  if(!windows.length) return {status:"not_measured" as const,overlappingRunIds,uncertainRunIds};
  const latest=Math.max(...windows.map(w=>w.finishAt));
  const names=await readdir(store.directory).catch(()=>null);
  if(!names) return {status:"unknown" as const,overlappingRunIds,uncertainRunIds};
  for(const name of names.sort()) {
    if(!/^run_[a-f0-9-]{36}\.json$/.test(name)) continue;
    const id=name.slice(0,-5);if(included.has(id)) continue;
    try {
      const r=await store.read(id);
      if(Date.parse(r.createdAt)>latest) continue;
      const h=history(r);
      if(h.intervals.some(i=>windows.some(w=>i.startAt<w.finishAt&&w.startAt<i.finishAt))) overlappingRunIds.push(id);
      if(h.uncertain) uncertainRunIds.push(id);
    } catch {uncertainRunIds.push(id);}
  }
  return {status:overlappingRunIds.length?"overlap_detected" as const:uncertainRunIds.length?"unknown" as const:"no_local_overlap_observed" as const,overlappingRunIds,uncertainRunIds};
}
