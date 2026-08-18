import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execStep, EngineError, loadConfig } from "../src/engine/engine.js";
import { claudeExecutor } from "../src/engine/executors/claude.js";
import { createClipboardExecutor } from "../src/engine/executors/clipboard.js";
import { codexExecutor } from "../src/engine/executors/codex.js";
import { getExecutor } from "../src/engine/executors/index.js";
import { loadWorkflow } from "../src/engine/loader.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot, setStep } from "./helpers.js";

// A clipboard executor whose writes land in `sink` instead of the OS clipboard.
function fakeClipboard(mode: "quiet" | "print" = "quiet", fail = false) {
  const sink: { written: string[]; out: string[]; err: string[] } = { written: [], out: [], err: [] };
  const executor = createClipboardExecutor({
    mode,
    write: async (text) => {
      if (fail) {
        throw new Error("no clipboard");
      }
      sink.written.push(text);
    },
    stdout: (t) => sink.out.push(t),
    stderr: (t) => sink.err.push(t)
  });
  return { executor, sink };
}

// Test 14 — loader defaults steps[].executor to "clipboard" (M0.4).
test("14: loader defaults executor to clipboard and rejects unknown values", () => {
  const { root, config } = makeRoot();
  for (const step of Object.values(config.steps)) {
    assert.equal(step.executor, "clipboard", `step "${step.id}" should default to clipboard`);
  }

  const { workflowYaml } = rootPaths(root);
  const raw = readFileSync(workflowYaml, "utf8");

  // an explicit, known executor is preserved
  writeFileSync(workflowYaml, raw.replace("  implementation:\n    role: codex", "  implementation:\n    role: codex\n    executor: codex"), "utf8");
  assert.equal(loadWorkflow(root).steps["implementation"].executor, "codex");

  // an unknown executor fails at load time, not at exec time
  writeFileSync(workflowYaml, raw.replace("  implementation:\n    role: codex", "  implementation:\n    role: codex\n    executor: telepathy"), "utf8");
  assert.throws(() => loadWorkflow(root), /unknown executor "telepathy"/);

  writeFileSync(workflowYaml, raw, "utf8");
});

// Test 15 — clipboard executor: quiet transfers the file body, print normalizes + narrates.
//
// 比較の前に改行だけ正規化する。成果物の改行表現は環境依存で（`.gitattributes` の `eol=lf` と
// `core.autocrlf` のどちらが効くかで CRLF / LF が変わる）、一方 assembleStepPrompt は
// 末尾の空白を落として改行を1つ付け直すため、CRLF の作業ツリーでは末尾だけが必ず食い違う。
// このテストが見たいのは「どの本文を配ったか」であって改行の表現ではない。
test("15: clipboard executor honours quiet vs print", async () => {
  const { root, config } = makeRoot();
  const step = config.steps["task-planning"];
  const body = readFileSync(path.join(rootPaths(root).promptsDir, "task-planning.md"), "utf8");
  const eol = (s: string) => s.split("\r\n").join("\n");

  const quiet = fakeClipboard("quiet");
  const quietResult = await quiet.executor.execute({ root, config, step });
  assert.equal(quietResult.ok, true);
  assert.deepEqual(quietResult.outputs, []);
  assert.deepEqual(quiet.sink.written.map(eol), [eol(body)], "quiet mode must copy the raw file body");
  assert.deepEqual(quiet.sink.out, [], "quiet mode must not write to stdout");
  assert.deepEqual(quiet.sink.err, []);

  const print = fakeClipboard("print");
  await print.executor.execute({ root, config, step });
  const normalized = `${eol(body).trimEnd()}\n`;
  assert.deepEqual(print.sink.out.map(eol), [normalized], "print mode writes the normalized body to stdout");
  assert.deepEqual(print.sink.written.map(eol), [normalized], "print mode copies the same normalized body");
  assert.deepEqual(print.sink.err, ["copied: prompt copied to clipboard."]);

  // clipboard failure is best-effort: still ok, with the reason in meta
  const broken = fakeClipboard("print", true);
  const brokenResult = await broken.executor.execute({ root, config, step });
  assert.equal(brokenResult.ok, true);
  assert.equal((brokenResult.meta as { outcome: string }).outcome, "copy-failed");
  assert.match(broken.sink.err[0], /^warning: clipboard copy failed/);

  // no prompt file for the step: not an error, promptFile is null
  rmSync(path.join(rootPaths(root).promptsDir, "task-planning.md"));
  const missing = await fakeClipboard("quiet").executor.execute({ root, config, step });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.meta, { executor: "clipboard", promptFile: null, outcome: "no-prompt" });
});

// Test 16 — `aiw exec` produces artifacts only: state.json must be byte-identical afterwards.
test("16: exec does not touch state.json", async () => {
  const { root, config } = makeRoot();
  const { stateFile } = rootPaths(root);
  setStep(root, "task-planning");
  const before = readFileSync(stateFile, "utf8");

  // inject the executor so the test never writes to the real OS clipboard
  const result = await execStep(root, config, "task-planning", { executor: fakeClipboard().executor });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(stateFile, "utf8"), before, "exec must not write state.json");
});

// Test 17 — exec reuses `run`'s preconditions (halted / awaiting approval / step mismatch).
test("17: exec refuses when halted, awaiting approval, or off the current step", async () => {
  const { root, config } = makeRoot();

  setStep(root, "research");
  await assert.rejects(() => execStep(root, config, "review"), (e: Error) => e instanceof EngineError && /current step is "research"/.test(e.message));
  await assert.rejects(() => execStep(root, config, "no-such-step"), /Unknown step "no-such-step"/);

  setStep(root, "task-planning", { pendingApproval: "task-planning" });
  await assert.rejects(() => execStep(root, config, "task-planning"), (e: Error) => e instanceof EngineError && /awaiting approval/.test(e.message));

  setStep(root, "task-planning", { status: "halted", haltedReason: "validation-failed" });
  await assert.rejects(() => execStep(root, config, "task-planning"), (e: Error) => e instanceof EngineError && /workflow is halted/.test(e.message));
});

// Test 18 — codex / claude are declared but not implemented until M2 / M3.
test("18: codex and claude executors report not-implemented", async () => {
  const { root, config } = makeRoot();
  const step = config.steps["implementation"];

  assert.equal(getExecutor("clipboard").name, "clipboard");
  assert.equal(getExecutor("codex"), codexExecutor);
  assert.equal(getExecutor("claude"), claudeExecutor);

  for (const [executor, milestone] of [
    [codexExecutor, "M2"],
    [claudeExecutor, "M3"]
  ] as const) {
    const result = await executor.execute({ root, config, step });
    assert.equal(result.ok, false);
    assert.deepEqual(result.outputs, []);
    assert.match(result.error ?? "", new RegExp(`${milestone} で実装予定`));
  }
});

// Test 19 — a not-implemented executor is logged as exec.failed but changes no state.
test("19: exec logs a failing executor without mutating state", async () => {
  const { root } = makeRoot();
  const { workflowYaml, stateFile, eventLog } = rootPaths(root);
  const raw = readFileSync(workflowYaml, "utf8");
  writeFileSync(workflowYaml, raw.replace("  implementation:\n    role: codex", "  implementation:\n    role: codex\n    executor: codex"), "utf8");

  setStep(root, "implementation");
  const before = readFileSync(stateFile, "utf8");
  const result = await execStep(root, loadConfig(root), "implementation");

  assert.equal(result.ok, false);
  assert.equal(readFileSync(stateFile, "utf8"), before, "a failed exec must not write state.json");

  const events = readFileSync(eventLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes("exec.started"), "exec.started must be logged");
  assert.ok(kinds.includes("exec.failed"), "exec.failed must be logged");
  assert.equal(events.find((e) => e.event === "exec.started")?.executor, "codex");

  writeFileSync(workflowYaml, raw, "utf8");
});
