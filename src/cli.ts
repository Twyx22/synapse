#!/usr/bin/env node
import { doctor } from "./core/doctor.ts";
import { leanAdvice } from "./core/lean.ts";
import { economicAdvice } from "./core/economics.ts";
import { CostLedger } from "./core/ledger.ts";
import { teamProfiles, teamAdvice } from "./core/team.ts";
import { rankBacklog } from "./core/backlog.ts";
import { EvolutionStore } from "./core/evolution.ts";
import { retrospective } from "./core/retrospective.ts";
import { ExperimentStore } from "./core/experiments.ts";
/** Local offline diagnostics entrypoint; no OpenCode installation or external service required. */
import { availableRuns, inspectRun, renderMonitor } from "./core/monitor.ts";
import { VERSION } from "./core/version.ts";
import { resolve, join } from "node:path";
import { projectStorage, resolveDataDirectory, migrateStorage, storageDoctor, discoverProjects, storageReport } from "./core/storage.ts";
import { pathToFileURL } from "node:url";
import { FileStore } from "./core/store.ts";
import { reviewedContribution, stageContribution } from "./core/contributions.ts";
import { DiagnosticLogger, DiagnosticReports } from "./core/diagnostics.ts";

export async function runCLI(argv: string[], cwd = process.cwd()): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(`Synapse diagnostics v${VERSION}
Usage:
  npm run doctor -- [--project PATH | --data-dir PATH]
  npm run lean -- --run RUN_ID [--project PATH | --data-dir PATH]
  npm run economics -- --run RUN_ID [--project PATH | --data-dir PATH]
  npm run costs -- [--project PATH | --data-dir PATH] [--run RUN_ID] [--budget-usd NUMBER]
  npm run team -- [--project PATH | --data-dir PATH] [--run RUN_ID]
  npm run backlog -- [--project PATH | --data-dir PATH]
  npm run storage -- projects
  npm run storage -- doctor [--project PATH]
  npm run storage -- migrate [--project PATH] [--source PATH]
  npm run report -- [--data-dir PATH] [--run RUN_ID]
  npm run log-status -- [--data-dir PATH]
  npm run monitor -- [--project PATH | --data-dir PATH] [--run RUN_ID] [--once]
  npm run profile -- [--project PATH | --data-dir PATH] [--run RUN_ID]
  npm run retrospective -- --run RUN_ID [--project PATH | --data-dir PATH]
  npm run strategy -- --run RUN_ID --model-label LABEL [--project PATH | --data-dir PATH]
  npm run experiments -- [--project PATH | --data-dir PATH] [--experiment EXPERIMENT_ID]
  npm run contribution -- inspect --project PATH --run RUN_ID --task TASK_ID
  npm run contribution -- stage --project PATH --run RUN_ID --task TASK_ID --sha256 HASH

Uses the exact project directory (XDG storage, or legacy data before migration).
The ZIP is created locally in the selected data directory/reports/ and is NEVER uploaded.
Inspect it before sharing; secret redaction is best-effort.`);
    return 0;
  }
  const command = argv[0];
  if (command === "storage") {
    const action=argv[1]; let project=cwd, source: string | undefined;
    if(action==="projects" && argv.length===2) { console.log(JSON.stringify(await discoverProjects(),null,2)); return 0; }
    if (! ["doctor","migrate"].includes(action)) throw new Error("Choose storage doctor or migrate");
    for(let i=2;i<argv.length;i+=2) { if(!argv[i+1]) throw new Error("Missing storage argument"); if(argv[i]==="--project") project=resolve(cwd,argv[i+1]); else if(argv[i]==="--source"&&action==="migrate") source=resolve(cwd,argv[i+1]); else throw new Error("Invalid storage argument"); }
    const loc=await projectStorage(project);
    console.log(JSON.stringify(action==="doctor"?await storageDoctor(loc):await migrateStorage(loc,source),null,2)); return 0;
  }
  if (command === "inspect" || command === "stage") {
    const opts = new Map<string,string>();
    for(let i=1;i<argv.length;i+=2) {
      if (!["--project","--run","--task","--sha256"].includes(argv[i]) || !argv[i+1] || opts.has(argv[i])) throw new Error("Invalid contribution arguments");
      opts.set(argv[i],argv[i+1]);
    }
    const project = opts.get("--project"), id = opts.get("--run"), task = opts.get("--task"), hash = opts.get("--sha256");
    if (!project || !id || !task || (command === "stage" && !hash)) throw new Error("Missing required contribution arguments");
    const root = resolve(cwd,project);
    const directory = await resolveDataDirectory(root);
    const run = await new FileStore(directory).read(id);
    if(command === "inspect") console.log(JSON.stringify(reviewedContribution(run,task),null,2));
    else {
      const result = await stageContribution(root,run,task,hash!);
      await new DiagnosticLogger(join(directory,"diagnostics")).log("info","contribution.staged",{runId:id,taskId:task,fileCount:result.paths.length});
      console.log(JSON.stringify(result,null,2));
    }
    return 0;
  }
  if (!["report", "log-status", "monitor", "profile", "experiments", "strategy", "retrospective", "backlog", "team", "costs", "economics", "lean", "doctor"].includes(command)) {
    console.error(`Unknown subcommand: ${command}`);
    return 2;
  }
  let directory: string | undefined;
  let reportProject: string | undefined=cwd;
  let runId: string | undefined;
  let once = false;
  let experimentId: string | undefined;
  let budgetUsd: number | undefined;
  let modelLabel: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" && argv[i + 1]) { directory = resolve(cwd, argv[++i]); reportProject=undefined; }
    else if (arg === "--project" && argv[i + 1]) { reportProject=resolve(cwd,argv[++i]); directory = await resolveDataDirectory(reportProject,["report","backlog"].includes(command)); }
    else if (arg === "--once" && command === "monitor") once = true;
    else if (arg === "--experiment" && command === "experiments" && argv[i+1]) experimentId = argv[++i];
    else if (arg === "--model-label" && command === "strategy" && argv[i+1]) modelLabel = argv[++i];
    else if (arg === "--budget-usd" && command === "costs" && argv[i+1]) budgetUsd=Number(argv[++i]);
    else if (arg === "--run" && argv[i + 1]) runId = argv[++i];
    else { console.error(`Invalid argument: ${arg}`); return 2; }
  }
  directory ??= await resolveDataDirectory(cwd,["report","backlog"].includes(command));
  if (runId && !/^run_[a-f0-9-]{36}$/.test(runId)) { console.error("Invalid run ID"); return 2; }
  if(command === "team") { const store=new FileStore(directory); console.log(JSON.stringify(runId?await teamAdvice(store,await store.read(runId)):await teamProfiles(store),null,2));return 0;}
  if (command === "backlog") {
    console.log(JSON.stringify(rankBacklog(await new EvolutionStore(join(directory,"evolution")).list()),null,2));return 0;
  }
  if (command === "retrospective") {
    if (!runId) {console.error("Provide --run");return 2;}
    console.log(JSON.stringify(retrospective(await new FileStore(directory).read(runId)),null,2));return 0;
  }
  if (command === "strategy") {
    if(!runId||!modelLabel) { console.error("Provide --run and --model-label");return 2; }
    console.log(JSON.stringify(await new ExperimentStore(new FileStore(directory)).advise(runId,modelLabel),null,2));return 0;
  }
  if (command === "experiments") {
    if(runId) { console.error("Use --experiment, not --run"); return 2; }
    const experiments = new ExperimentStore(new FileStore(directory));
    console.log(JSON.stringify(experimentId ? await experiments.evaluate(experimentId) : await experiments.list(),null,2));
    return 0;
  }
  if (command === "monitor" || command === "profile") {
    do {
      const runs = await availableRuns(directory);
      const selected = runId ?? runs.find(r => r.status === "running")?.id ?? runs[0]?.id;
      if (!selected) { console.log(`No readable runs in ${directory}`); if (once || command === "profile") return 1; }
      else {
        try {
          const view = await inspectRun(directory, selected);
          if (command === "profile") { console.log(JSON.stringify(view,null,2)); return 0; }
          if (process.stdout.isTTY && !once) process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderMonitor(view));
        } catch (err) { console.error(String(err)); if (once || command === "profile") return 1; }
      }
      if (once) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (true);
    return 0;
  }
  if(command === "doctor") {
    const loc=reportProject?await projectStorage(reportProject):undefined;
    const result=await doctor(directory,loc?()=>storageDoctor(loc):undefined);
    console.log(JSON.stringify(result,null,2));return result.status==='ok'?0:1;
  }
  const logger = new DiagnosticLogger(join(directory, "diagnostics"));
  if (command === "lean") {
    if(!runId) {console.error("Provide --run");return 2;}
    console.log(JSON.stringify(leanAdvice(await new FileStore(directory).read(runId)),null,2));return 0;
  }
  if (command === "economics") {
    if(!runId) {console.error("Provide --run");return 2;}
    const run=await new FileStore(directory).read(runId);
    console.log(JSON.stringify(economicAdvice(run,await new CostLedger(directory).summary(await logger.recent(),runId)),null,2));return 0;
  }
  if (command === "costs") {
    if(runId)await new FileStore(directory).read(runId);
    console.log(JSON.stringify(await new CostLedger(directory).summary(await logger.recent(),runId,budgetUsd),null,2));return 0;
  }
  if (command === "log-status") {
    console.log(JSON.stringify(await logger.status(), null, 2));
    return 0;
  }
  const location=reportProject ? await projectStorage(reportProject) : undefined;
  const result = await new DiagnosticReports(directory, logger, location ? () => storageReport(location,directory!) : undefined).build({ runId });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(err => {
    console.error(`Synapse diagnostics failed: ${String(err)}`);
    process.exitCode = 1;
  });
}
