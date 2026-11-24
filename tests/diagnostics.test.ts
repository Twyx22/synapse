import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticLogger, DiagnosticReports, redact } from "../src/core/diagnostics.ts";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { runCLI } from "../src/cli.ts";
import { registerTools, type ToolDef } from "../src/opencode/tools.ts";

const newDir = () => mkdtemp(join(tmpdir(), "synapse-diag-"));

function readZipContents(content: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (p + 30 <= content.length && content.readUInt32LE(p) === 0x04034b50) {
    const compressedLength = content.readUInt32LE(p + 18);
    const nameSize = content.readUInt16LE(p + 26);
    const extraSize = content.readUInt16LE(p + 28);
    const name = content.subarray(p + 30, p + 30 + nameSize).toString("utf8");
    const bodyStart = p + 30 + nameSize + extraSize;
    out.set(name, content.subarray(bodyStart, bodyStart + compressedLength).toString("utf8"));
    p = bodyStart + compressedLength;
  }
  return out;
}

test("redactor masks bearer tokens, API keys, emails and private paths", () => {
  const sample = "Bearer ABCDEFG1234567 API_KEY=abc12345 password=hunter2 user@example.org /home/alex/projects 192.168.10.1 sk-proj-ABCDEFGHIJKLMNOP";
  const safe = redact(sample);
  for (const sensitive of ["ABCDEFG1234567", "abc12345", "hunter2", "user@example.org", "alex", "192.168.10.1", "sk-proj-ABCDEFGHIJKLMNOP"]) {
    assert.ok(!safe.includes(sensitive), `${sensitive} should not be visible`);
  }
  assert.ok(safe.includes("[REDACTED]"));
});

test("logger persists structured events, omits raw bodies, rotates without exceeding file cap", async () => {
  const dir = await newDir();
  try {
    const log = new DiagnosticLogger(join(dir, "diagnostics"), { maxBytes: 512, maxFiles: 3 });
    await log.log("info", "synapse.started", { runId: "run_test", body: "TOP_SECRET_BODY", error: new Error("password=hunter2") });
    for (let i = 0; i < 20; i++) await log.log("info", "test.pulse", { attempt: i, status: "active", notes: "x".repeat(45) });
    const files = (await readdir(log.directory)).filter(n => n.startsWith("synapse.jsonl"));
    assert.ok(files.length >= 2 && files.length <= 3);
    const recent = await log.recent();
    assert.ok(recent.includes("test.pulse"));
    assert.ok(!recent.includes("TOP_SECRET_BODY"));
    assert.equal((await log.status()).loggingErrors.count, 0);
    assert.ok(files.every(n => /^synapse\.jsonl(\.\d+)?$/.test(n)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("report ZIP excludes raw prompts, results, private messages, and redacts errors", async () => {
  const dir = await newDir();
  try {
    const logger = new DiagnosticLogger(join(dir, "diagnostics"));
    const engine = new Synapse(new FileStore(dir, logger), { execute: async () => ({ text: "PRIVATE_RESULT_9876" }) });
    const run = await engine.plan("PRIVATE_OBJECTIVE_1234", [{ id: "analysis", title: "PRIVATE_TITLE", instruction: "PRIVATE_INSTRUCTION_7777", review: false }]);
    await engine.send(run.id, "coordinator", "all", "note", "PRIVATE_MESSAGE_3456");
    await engine.run(run.id);
    await logger.log("error", "model.network.error", { error: "Bearer VERYSECRETTOKEN and password=abcd1234" });
    const report = await new DiagnosticReports(dir, logger).build({ runId: run.id });
    assert.equal(report.runCount, 1);
    assert.ok(report.bytes > 500);
    assert.equal((await stat(report.filePath)).mode & 0o777, 0o600);
    const entries = readZipContents(await readFile(report.filePath));
    assert.deepEqual([...entries.keys()], ["README.txt", "manifest.json", "runs.json", "logs.jsonl", "costs.json", "economics.json"]);
    const all = [...entries.values()].join("\n");
    for (const privateText of ["PRIVATE_OBJECTIVE_1234", "PRIVATE_TITLE", "PRIVATE_INSTRUCTION_7777", "PRIVATE_RESULT_9876", "PRIVATE_MESSAGE_3456", "VERYSECRETTOKEN", "abcd1234"]) {
      assert.ok(!all.includes(privateText), `${privateText} must never appear in diagnostic ZIP`);
    }
    assert.ok(all.includes("run.completed") || all.includes("run.finished"));
    const summary = JSON.parse(entries.get("runs.json")!);
    assert.equal(summary[0].tasks[0].status, "completed");
    assert.equal(summary[0].messagesByType.note, 1);
    assert.equal(summary[0].tasks[0].reviewed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("report remains usable with corrupted saved run and missing log directory", async () => {
  const dir = await newDir();
  try {
    const logger = new DiagnosticLogger(join(dir, "diagnostics"));
    const engine = new Synapse(new FileStore(dir), { execute: async () => ({ text: "ok" }) });
    const run = await engine.plan("test", [{ id: "one", title: "One", instruction: "Work" }]);
    const path = join(dir, `${run.id}.json`);
    await import("node:fs/promises").then(fs => fs.writeFile(path, "{broken"));
    const report = await new DiagnosticReports(dir, logger).build();
    assert.equal(report.runCount, 0);
    assert.equal(report.warnings.length, 1);
    assert.ok((await stat(report.filePath)).size > 100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("coordinator can export a report via OpenCode tool, workers cannot", async () => {
  const dir = await newDir();
  try {
    const logger = new DiagnosticLogger(join(dir, "diagnostics"));
    const engine = new Synapse(new FileStore(dir, logger), { execute: async () => ({ text: "ok" }) });
    const defs = new Map<string, ToolDef>();
    await registerTools({ transform: async fn => {
      fn({ namespace: () => undefined, add: entry => defs.set(entry.name, entry) });
      return undefined;
    } }, engine, undefined, new DiagnosticReports(dir, logger));
    assert.equal(defs.size, 27);
    const context = { sessionID: "coordinator", signal: new AbortController().signal };
    const answer = JSON.parse((await defs.get("diagnostics_export")!.execute({}, context)).content);
    assert.ok(answer.filePath.endsWith(".zip"));
    await stat(answer.filePath);
    const run = await engine.plan("plan", [{ id: "a", title: "A", instruction: "Do" }]);
    assert.ok(run.id);
    assert.equal((JSON.parse((await defs.get("diagnostics_status")!.execute({}, context)).content)).loggingErrors.count, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI generates diagnostic ZIP offline with explicit --data-dir", async () => {
  const dir = await newDir();
  try {
    const result = await runCLI(["report", "--data-dir", dir]);
    assert.equal(result, 0);
    assert.equal((await readdir(join(dir, "reports"))).length, 1);
    assert.equal(await runCLI(["report", "--run", "not_a_run"], dir), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("logging failure does not abort work or cause unhandled promise rejections", async () => {
  const dir = await newDir();
  try {
    const { writeFile } = await import("node:fs/promises");
    const badPath = join(dir, "not-directory");
    await writeFile(badPath, "file");
    const logger = new DiagnosticLogger(badPath);
    const engine = new Synapse(new FileStore(join(dir, "data"), logger), { execute: async () => ({ text: "still works" }) });
    const run = await engine.plan("example", [{ id: "task", title: "Task", instruction: "Read", review: false }]);
    const result = await engine.run(run.id);
    await logger.flush();
    assert.equal(result.status, "completed");
    assert.ok(logger.errors.count >= 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("logs with one-file limit do not keep rotated copies", async () => {
  const dir = await newDir();
  try {
    const log = new DiagnosticLogger(dir, { maxBytes: 512, maxFiles: 1 });
    for (let i = 0; i < 30; i++) await log.log("info", "heartbeat", { attempt: i, notes: "x".repeat(50) });
    const files = await readdir(dir);
    assert.deepEqual(files, ["synapse.jsonl"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
