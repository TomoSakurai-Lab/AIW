import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import AjvModule from "ajv";
import { checkMarkdownSections } from "./artifactContract.js";

// Interop shim: under NodeNext, ajv v8's default export can arrive wrapped. Resolve the class.
const Ajv: any = (AjvModule as any).default ?? AjvModule;
import { resolveConfigRef } from "./paths.js";
import { estimateTokens } from "./tokens.js";
import { isDeclared, parseDeclaredFiles } from "./declaredFiles.js";
import { compareToBaseline, readBaseline, readRepoState, resolveCheckRepoRoot } from "./gitScope.js";
import { knownFailureHint, runVerifyLocal, scopeNote, type VerifyLocalCommand } from "./verifyLocal.js";
import type { ValidatorRef, WorkflowConfig } from "./types.js";

export type Violation = {
  type: ValidatorRef["type"];
  onViolation: "report" | "halt";
  message: string;
};

// Tri-state on purpose. The previous shape was `passed: boolean` + `skipped?: boolean`, which let
// a validator be recorded as `{ passed: true, skipped: true }` — a not-run check indistinguishable
// from a successful one. Everything downstream then read `passed` and counted it as a success.
// With a single `status` field that combination cannot be expressed.
export type ValidatorStatus = "passed" | "failed" | "skipped";

export type ValidatorResult = {
  type: ValidatorRef["type"];
  target?: string;
  status: ValidatorStatus;
  /** why it did not run (status === "skipped") */
  skipReason?: string;
  message: string;
  /** validator 固有の構造化情報。diff-scope が scope-violation-report.md の材料に使う */
  detail?: Record<string, unknown>;
};

// diff-scope が baseline の capturedFor を照合するのに要る。他の validator は使わない。
export type ValidationContext = {
  stepId: string;
  fixAttempts: number;
};

export type ValidationOutcome = {
  results: ValidatorResult[];
  violations: Violation[];
  halt: boolean; // true if any halting validator failed
};

// Fixed execution order (§7.2): existence → structure → content. Lower runs first.
const ORDER: Record<ValidatorRef["type"], number> = {
  "file-exists": 0,
  "json-schema": 1,
  "artifact-contract": 1,
  "token-range": 2,
  "diff-scope": 3,
  "verify-local": 4,
  "command-exit-code": 4,
  "consumer-presence": 4,
  "measurement-completeness": 4
};

// Validators that are declared in workflow.yaml but deliberately not executed yet. They are NOT
// silently treated as passing: each produces `status: "skipped"` with the reason below, which the
// pipeline records to the Event Log and `aiw status --summary` displays. Emptying this map is the
// goal; whatever stays here must justify itself in docs/aiw-known-issues.md.
const NOT_IMPLEMENTED: Partial<Record<ValidatorRef["type"], string>> = {
  "command-exit-code": "testing step (role: cli) is out of MVP scope"
};

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCache = new Map<string, ReturnType<typeof ajv.compile>>();

function compileSchema(schemaPath: string) {
  const cached = schemaCache.get(schemaPath);
  if (cached) {
    return cached;
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schema);
  schemaCache.set(schemaPath, validate);
  return validate;
}

function abs(root: string, rel: string): string {
  return path.join(path.resolve(root), rel);
}

type RunOne = { status: ValidatorStatus; message: string; target?: string; skipReason?: string; detail?: Record<string, unknown> };

const passed = (message: string, target?: string): RunOne => ({ status: "passed", message, target });
const failed = (message: string, target?: string, detail?: Record<string, unknown>): RunOne =>
  ({ status: "failed", message, target, detail });
const skipped = (skipReason: string, message: string): RunOne => ({ status: "skipped", skipReason, message });

function runOne(root: string, config: WorkflowConfig, v: ValidatorRef, ctx?: ValidationContext): RunOne {
  switch (v.type) {
    case "file-exists": {
      const missing = (v.targets ?? []).filter((t) => !existsSync(abs(root, t)));
      return missing.length === 0
        ? passed("all required outputs present")
        : failed(`missing output(s): ${missing.join(", ")}`);
    }
    case "json-schema": {
      const target = v.target!;
      const file = abs(root, target);
      if (!existsSync(file)) {
        return failed(`${target} does not exist`, target);
      }
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error);
        return failed(`${target} is not valid JSON: ${m}`, target);
      }
      const validate = compileSchema(resolveConfigRef(root, v.schema!));
      const ok = validate(data);
      return ok
        ? passed(`${target} matches schema`, target)
        : failed(`${target} schema violation: ${ajv.errorsText(validate.errors)}`, target);
    }
    case "artifact-contract": {
      const def = config.artifacts[v.artifact!];
      if (!def) {
        return failed(`unknown artifact "${v.artifact}"`);
      }
      const target = def.path;
      const file = abs(root, target);
      if (!existsSync(file)) {
        return failed(`${target} does not exist`, target);
      }
      const content = readFileSync(file, "utf8");
      if (def.contract.type === "markdown-sections") {
        const res = checkMarkdownSections(content, def.contract.sections);
        return res.ok
          ? passed(`${target} has all required sections`, target)
          : failed(`${target} missing section(s): ${res.missing.join(", ")}`, target);
      }
      // json-schema contract
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error);
        return failed(`${target} is not valid JSON: ${m}`, target);
      }
      const validate = compileSchema(resolveConfigRef(root, def.contract.schema));
      const ok = validate(data);
      return ok
        ? passed(`${target} matches contract schema`, target)
        : failed(`${target} contract violation: ${ajv.errorsText(validate.errors)}`, target);
    }
    case "token-range": {
      const target = v.target!;
      const file = abs(root, target);
      if (!existsSync(file)) {
        return failed(`${target} does not exist`, target);
      }
      const tokens = estimateTokens(readFileSync(file, "utf8"));
      const min = v.min ?? 0;
      const max = v.max ?? Number.POSITIVE_INFINITY;
      return tokens >= min && tokens <= max
        ? passed(`${target} ~${tokens} tokens (in [${min}, ${max}])`, target)
        : failed(`${target} ~${tokens} tokens outside [${min}, ${max}]`, target);
    }
    case "diff-scope":
      return runDiffScope(root, config, v, ctx);
    case "verify-local":
      return runVerifyLocalValidator(root, config, v);
    case "consumer-presence":
      return runConsumerPresence(root, v);
    case "measurement-completeness":
      return runMeasurementCompleteness(root, v);
    default:
      // Unreachable while NOT_IMPLEMENTED covers every unhandled type. Failing (rather than
      // passing) keeps an unknown validator from becoming a silent success.
      return failed(`validator "${v.type}" has no implementation`);
  }
}

function jsonFile(root: string, rel: string): unknown | null {
  const file = abs(root, rel);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "bin", "obj", "dist"].includes(name)) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) out.push(...filesUnder(file));
    else out.push(file);
  }
  return out;
}

function runConsumerPresence(root: string, v: ValidatorRef): RunOne {
  const consumerRoot = v.consumerRoot ?? ".";
  const dir = abs(root, consumerRoot);
  if (!existsSync(dir)) return skipped(`consumer root does not exist: ${consumerRoot}`, `consumer-presence skipped: ${consumerRoot} is absent`);
  if (!v.apiPattern) return skipped("no apiPattern configured", "consumer-presence skipped: no apiPattern configured");
  let pattern: RegExp;
  try { pattern = new RegExp(v.apiPattern, "m"); } catch { return failed(`invalid apiPattern: ${v.apiPattern}`); }
  const count = filesUnder(dir).filter((file) => pattern.test(readFileSync(file, "utf8"))).length;
  const minimum = v.minConsumers ?? 1;
  if (count < minimum) return failed(`consumer-presence found ${count} consumer(s), expected at least ${minimum} under ${consumerRoot}`);
  if (v.manifest && v.result) {
    const manifest = jsonFile(root, v.manifest) as { acceptanceCriteria?: { id: string; implementationStatus?: string }[] } | null;
    const result = jsonFile(root, v.result) as { results?: { id: string; status: string }[] } | null;
    if (manifest && result) {
      const statuses = new Map((result.results ?? []).map((item) => [item.id, item.status.toLowerCase().replace(/\s+/g, "-")]));
      const misreported = (manifest.acceptanceCriteria ?? []).filter(
        (item) => item.implementationStatus === "not-implemented" && statuses.get(item.id) === "not-verified"
      );
      if (misreported.length > 0) return failed(`consumer-presence found unimplemented AC reported as NOT VERIFIED: ${misreported.map((x) => x.id).join(", ")}`);
    }
  }
  return passed(`consumer-presence found ${count} consumer(s) under ${consumerRoot}`);
}

function runMeasurementCompleteness(root: string, v: ValidatorRef): RunOne {
  const manifest = v.manifest ? jsonFile(root, v.manifest) : null;
  const result = v.result ? jsonFile(root, v.result) : null;
  if (manifest === null || result === null) return skipped("manifest or result is absent", "measurement-completeness skipped: optional inputs are absent");
  const expected = (manifest as { acceptanceCriteria?: { id: string; notApplicable?: boolean }[] }).acceptanceCriteria ?? [];
  const actual = (result as { results?: { id: string; status: string }[] }).results ?? [];
  const ids = actual.map((item) => item.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const expectedIds = expected.filter((item) => !item.notApplicable).map((item) => item.id);
  const missing = expectedIds.filter((id) => !ids.includes(id));
  if (duplicates.length > 0 || missing.length > 0) {
    return failed(`measurement-completeness missing: ${missing.join(", ") || "none"}; duplicate: ${duplicates.join(", ") || "none"}`);
  }
  const invalid = actual.filter((item) => !["passed", "failed", "skipped"].includes(item.status));
  if (invalid.length > 0) return failed(`measurement-completeness has invalid status for ${invalid.map((x) => x.id).join(", ")}`);
  return passed(`measurement-completeness recorded ${actual.length} result(s)`);
}

// Runs a step's validators in fixed order. A failing `halt` validator stops the pipeline;
// failing `report` validators are collected but do not halt.
export function runValidators(
  root: string,
  config: WorkflowConfig,
  validators: ValidatorRef[] = [],
  ctx?: ValidationContext
): ValidationOutcome {
  const ordered = [...validators].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  const outcome: ValidationOutcome = { results: [], violations: [], halt: false };

  for (const v of ordered) {
    const skipReason = NOT_IMPLEMENTED[v.type];
    if (skipReason !== undefined) {
      outcome.results.push({
        type: v.type,
        status: "skipped",
        skipReason,
        message: `${v.type} was declared (onViolation: ${v.onViolation}) but did not run: ${skipReason}`
      });
      continue;
    }
    const r = runOne(root, config, v, ctx);
    outcome.results.push({
      type: v.type,
      target: r.target,
      status: r.status,
      skipReason: r.skipReason,
      message: r.message,
      detail: r.detail
    });
    if (r.status === "failed") {
      outcome.violations.push({ type: v.type, onViolation: v.onViolation, message: r.message });
      if (v.onViolation === "halt") {
        outcome.halt = true;
        break; // early-stop: don't run later (content) validators once a halting check fails
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// diff-scope — 宣言されたファイル以外が変更されていないか（設計 docs/design-diff-scope.md）
// ---------------------------------------------------------------------------
//
// 層の分離: gitScope.compareToBaseline は「何が変わったか」という**事実**を返し、
// ここは「それが許されるか」という**判断**を行う。
//   violations = changed − declared − exclude
//
// 検査範囲は違反の有無にかかわらず必ずメッセージへ入れる。v1 は1タスク1リポジトリで、
// ネストしたリポジトリ（tools/aiw）と ignore 済みパスは検査対象外。これを書かないと
// 「検査した結果、問題なし」と「そもそも検査していない」が区別できない。
function scopeSuffix(repoRoot: string | null): string {
  return `checked ${repoRoot ?? "(unresolved)"} (nested repos and ignored paths not checked)`;
}

// 欠損時の倒し方は onViolation で決まる（設計課題4）。
//   report 宣言(implementation) → skipped: 検査できなかったことを「違反あり」と偽らない
//   halt 宣言(fix)              → failed:  halt 宣言の validator が skipped で素通りするのは
//                                          KI-04 で潰したバグクラスの再発
function unavailable(v: ValidatorRef, reason: string, repoRoot: string | null): RunOne {
  const message = `${reason}; ${scopeSuffix(repoRoot)}`;
  return v.onViolation === "halt" ? failed(message) : skipped(reason, message);
}

function isExcluded(target: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.split("\\").join("/");
    if (p.endsWith("*")) {
      return target.startsWith(p.slice(0, -1));
    }
    return target === p || target.startsWith(p.endsWith("/") ? p : `${p}/`);
  });
}

function runDiffScope(root: string, config: WorkflowConfig, v: ValidatorRef, ctx?: ValidationContext): RunOne {
  const resolved = resolveCheckRepoRoot(root, config);
  const repoRoot = resolved.ok ? resolved.repoRoot : null;

  if (!ctx) {
    // パイプライン外からの呼び出し。baseline の照合キーが無いので検査できない。
    return unavailable(v, "no validation context (called outside the pipeline)", repoRoot);
  }
  if (!resolved.ok) {
    return unavailable(v, `checkRepoRoot could not be resolved: ${resolved.reason}`, null);
  }

  const baseline = readBaseline(root);
  if (!baseline) {
    return unavailable(v, "no baseline.json (task baseline was never captured)", repoRoot);
  }
  if (baseline.capturedFor.step !== ctx.stepId || baseline.capturedFor.fixAttempts !== ctx.fixAttempts) {
    return unavailable(
      v,
      `baseline is for ${baseline.capturedFor.step}#${baseline.capturedFor.fixAttempts}, not ${ctx.stepId}#${ctx.fixAttempts}`,
      repoRoot
    );
  }

  const source = v.declaredFilesFrom;
  const section = source === "current-review.md" ? "### Files To Modify" : "## Modify";
  const sourceFile = abs(root, source ?? "context-package.md");
  if (!existsSync(sourceFile)) {
    return unavailable(v, `declaration source ${source} does not exist`, repoRoot);
  }
  const declared = parseDeclaredFiles(readFileSync(sourceFile, "utf8"), section);
  if (!declared.ok) {
    // 契約(artifact-contract)が保証しているはずの見出しが無い。「検査できなかった」ではなく
    // 契約違反なので failed。onViolation の宣言どおり implementation は report / fix は halt。
    return failed(`${source} has no "${section}" section; ${scopeSuffix(repoRoot)}`);
  }

  let current;
  try {
    current = readRepoState(resolved.repoRoot);
  } catch (error) {
    return unavailable(v, `git failed: ${(error as Error).message}`, repoRoot);
  }

  const cmp = compareToBaseline(baseline, current);
  const exclude = config.settings.diffScope?.exclude ?? [];
  const violations = cmp.changed.filter(
    (c) => !isDeclared(c.path, declared, cmp.ignoreCase) && !isExcluded(c.path, exclude)
  );

  const headNote = cmp.headMoved
    ? ` HEAD moved since baseline (${short(cmp.headMoved.baselineSha)} -> ${short(cmp.headMoved.currentSha)}); commits during the task are not violations.`
    : "";
  const ageNote = ` baseline captured ${baseline.capturedAt}.`;

  // 「検査対象に何も変更が無かった」を「検査して問題なかった」と同じ表示にしない。
  //
  // 宣言があるのに変更が 0 件なのは正常系ではまず起きない。起きるとすれば
  // repoRoot が違う / Codex が何もしなかった / 検査対象外の場所に書いた のいずれかで、
  // どれも人間が知るべき状態。無人運転では誰もメッセージを読まないので、
  // 「違反なし」と文面を分けておくことが唯一の手がかりになる。
  // 第1部で skipped を成功に見せなかったのと同じ論理。
  const nothingObserved = cmp.changed.length === 0 && (declared.files.length > 0 || declared.dirPrefixes.length > 0);
  if (nothingObserved) {
    return passed(
      `no changes observed in the checked repository — verify repoRoot if unexpected; ` +
        `${scopeSuffix(repoRoot)}.${headNote}`
    );
  }

  if (violations.length === 0) {
    return passed(`no changes outside the declaration; ${scopeSuffix(repoRoot)}.${headNote}`);
  }

  // シナリオ7: baseline 時点で既に dirty だったファイルは、誰の変更か原理的に判別できない。
  const uncertain = violations.filter((c) => c.kind === "modified-since").map((c) => c.path);
  const uncertainNote =
    uncertain.length > 0
      ? ` ${uncertain.length} of these were already modified at baseline time (${uncertain.join(", ")}) — may be a human edit.`
      : "";

  return failed(
    `${violations.length} file(s) changed outside the declaration in ${source}: ` +
      `${violations.map((c) => c.path).join(", ")}; ${scopeSuffix(repoRoot)}.${uncertainNote}${headNote}${ageNote}`,
    undefined,
    {
      checkRepoRoot: repoRoot,
      declarationSource: source,
      declarationSection: section,
      capturedAt: baseline.capturedAt,
      capturedFor: baseline.capturedFor,
      headMoved: cmp.headMoved,
      ignoreCase: cmp.ignoreCase,
      declaredCount: declared.files.length + declared.dirPrefixes.length,
      violations: violations.map((c) => ({ path: c.path, kind: c.kind, state: c.state }))
    }
  );
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "(none)";
}

// ---------------------------------------------------------------------------
// verify-local — ローカルで決定論的に実行できる検証（設計 M1.5 第3部）
// ---------------------------------------------------------------------------
//
// 検査範囲（何件見たか / 何を見ていないか）を **違反の有無にかかわらず** メッセージへ出す。
// `tsc --noEmit` は対象0件でも exit 0 を返すので、これが無いと
// 「コマンドは走ったが実は何も見ていない」と「検査して問題なし」が区別できない。
// diff-scope の `checked <repoRoot>` と同じ論理。
function runVerifyLocalValidator(root: string, config: WorkflowConfig, v: ValidatorRef): RunOne {
  const key = v.command;
  const spec = key ? (config.settings.verifyLocal?.[key] as VerifyLocalCommand | undefined) : undefined;
  if (!key) {
    return unavailableLocal(v, "validator has no `command` key");
  }
  if (!spec) {
    return unavailableLocal(v, `settings.verifyLocal."${key}" is not defined`);
  }

  const resolved = resolveCheckRepoRoot(root, config);
  if (!resolved.ok) {
    return unavailableLocal(v, `checkRepoRoot could not be resolved: ${resolved.reason}`);
  }

  const patterns = loadKnownFailurePatterns(root, config.settings.knownFailurePatternsFile);
  const outcome = runVerifyLocal(resolved.repoRoot, {
    ...spec,
    knownFailurePatterns: [...(spec.knownFailurePatterns ?? []), ...patterns]
  });
  if (outcome.kind === "skipped") {
    // タイムアウト・起動失敗・0件はすべてここ。**failed にしない。**
    // 「型エラーがあった」ではなく「検査が完了しなかった」なので、
    // report 宣言の validator が failed を返すと意味的に偽ることになる（設計課題4と同じ）。
    const note = scopeNote(spec, outcome.fileCount ?? null, outcome.durationMs);
    return skipped(`${key}: ${outcome.reason}`, `${key} did not complete: ${outcome.reason}; ${note}`);
  }

  const note = scopeNote(spec, outcome.fileCount, outcome.durationMs);
  if (outcome.kind === "passed") {
    return passed(`${key} passed — ${note}`);
  }
  const hint = knownFailureHint(outcome.output, [...(spec.knownFailurePatterns ?? []), ...patterns]);
  return failed(`${key} failed (exit ${outcome.exitCode ?? "?"}) — ${note}${hint ? `; ${hint}` : ""}`, undefined, {
    command: key,
    cwd: spec.cwd ?? ".",
    exitCode: outcome.exitCode,
    fileCount: outcome.fileCount,
    durationMs: outcome.durationMs,
    notChecked: spec.notChecked ?? null,
    output: outcome.output,
    knownFailureHint: hint
  });
}

function loadKnownFailurePatterns(root: string, file?: string): { pattern: string; guidance: string }[] {
  if (!file) return [];
  const absolute = abs(root, file);
  if (!existsSync(absolute)) return [];
  const patterns: { pattern: string; guidance: string }[] = [];
  for (const line of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const match = line.match(/aiw-known-failure:\s*pattern=([^|]+)\|\s*guidance=(.+?)\s*-->/i);
    if (match) patterns.push({ pattern: match[1].trim(), guidance: match[2].trim() });
  }
  return patterns;
}

function unavailableLocal(v: ValidatorRef, reason: string): RunOne {
  return v.onViolation === "halt" ? failed(reason) : skipped(reason, reason);
}
