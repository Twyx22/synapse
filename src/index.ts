import { installRetryHook, subscribeFailures } from "./opencode/resilience.ts";
import { installToolHook } from "./opencode/toolset.ts";
import { CostLedger } from "./core/ledger.ts";
/** OpenCode V2 plugin entry point. */
import { VERSION } from "./core/version.ts";
import { Plugin } from "@opencode/plugin";
import { initializeStorage, storageDoctor, storageReport } from "./core/storage.ts";
import { resolve } from "node:path";
import { FileStore } from "./core/store.ts";
import { Synapse } from "./core/orchestrator.ts";
import { EvolutionCouncil, EvolutionStore } from "./core/evolution.ts";
import { DiagnosticLogger, DiagnosticReports } from "./core/diagnostics.ts";
import { OpenCodeAdapter } from "./opencode/adapter.ts";
import { registerTools, type ToolAPI } from "./opencode/tools.ts";
import type { SessionApi } from "./opencode/adapter.ts";

export default Plugin.define({
  id: "synapse",
  async setup(ctx) {
    const location = await initializeStorage(ctx.location.directory);
    const { directory, migration } = location;
    const logger = new DiagnosticLogger(resolve(directory, "diagnostics"));
    const reports = new DiagnosticReports(directory, logger, () => storageReport(location,directory));
    await logger.log("info", "plugin.setup.started", { version: VERSION });
    if (migration.status === "finished") await logger.log("info", "storage.migrated", { imported: migration.imported, conflicts: migration.conflicts, invalid: migration.invalid });
    const store = new FileStore(directory, logger);
    const adapter = new OpenCodeAdapter(ctx.session as unknown as SessionApi, logger, undefined, new CostLedger(directory));
    // Feature detection keeps older hosts operational. Do not alter global tool registration.
    adapter.setToolHookAvailable(await installToolHook(ctx.session, event => adapter.filterTools(event)));
    const retryHook = await installRetryHook(ctx.session, event => adapter.observeRetry(event));
    const engine = new Synapse(store, adapter);
    const evolution = new EvolutionCouncil(new EvolutionStore(resolve(directory, "evolution")), adapter, logger);
    engine.onRunFinished(run => evolution.onRunFinished(run));
    await registerTools(ctx.tool as unknown as ToolAPI, engine, evolution, reports, id => adapter.isRestricted(id), (id, text) => adapter.submit(id, text), (id, approved, reason) => adapter.submitReview(id, approved, reason), () => storageDoctor(location), id => adapter.coordinatorUsage(id));
    const unsubscribe = subscribeFailures(ctx.event, event => adapter.observeTerminal(event), () => {void logger.log("warn","agent.provider.stream_error",{});});
    await logger.log("info", "plugin.setup.provider", {retryHook, terminalEvents: !!unsubscribe});
    await logger.log("info", "plugin.setup.completed", { version: VERSION });
    return unsubscribe;
  },
});
