/** Exact task-DAG width via transitive closure and bipartite maximum matching (Dilworth). No duration prediction. */
import type { RunRecord } from "./types.ts";
export function topology(run:RunRecord) {
  const tasks=run.tasks, n=tasks.length;
  const index=new Map(tasks.map((t,i)=>[t.id,i]));
  const reach=Array.from({length:n},()=>Array<boolean>(n).fill(false));
  for(const [j,t] of tasks.entries()) for(const d of t.dependsOn) {const i=index.get(d);if(i!==undefined)reach[i][j]=true;}
  for(let k=0;k<n;k++)for(let i=0;i<n;i++)if(reach[i][k])for(let j=0;j<n;j++)if(reach[k][j])reach[i][j]=true;
  const right=Array<number>(n).fill(-1);
  function augment(i:number,seen:Set<number>):boolean {
    for(let j=0;j<n;j++)if(reach[i][j]&&!seen.has(j)) {
      seen.add(j);if(right[j]===-1||augment(right[j],seen)){right[j]=i;return true;}
    }return false;
  }
  let matching=0;for(let i=0;i<n;i++)if(augment(i,new Set()))matching++;
  const width=n-matching;
  return {taskCount:n,maxIndependentTasks:width,requiredReviews:tasks.filter(t=>t.review).length,
    concurrencyAboveWidth:run.options.concurrency>width,
    caveat:"DAG width is a structural upper bound on simultaneous tasks, not a speed or model-cost prediction. Reviews stay required."};
}
