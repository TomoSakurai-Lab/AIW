// `aiw pr` の手順（docs/design-pr.md）。作成 or 更新・画像の添付・縮退・Event Log。
//
// 確定済みの判断（再検討しない）:
//   1. draft 固定。公開は人間     2. REST 直叩き     3. PAT は env のみ・どこにも出さない
//   4. state.json を読まず変えない（このファイルは state.ts / engine.ts / completion.ts を import しない・test 267）
//   5. 冪等キー = ソースブランチ  6. 失敗は report 相当（タスクの完了を妨げない）  7. --dry-run は API を一切呼ばない
//
// 出力（stdout / stderr / Event Log）は**すべて最終段で redactPat を通す**（F-1）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { appendEvent, type EventType } from "../eventLog.js";
import { resolveCheckRepoRoot } from "../gitScope.js";
import type { PrSettings, WorkflowConfig } from "../types.js";
import { AzdoClient, AzdoError, deriveFromRemote, resolveTarget, type AzdoPullRequest, type FetchImpl } from "./azdo.js";
import {
  buildDescription,
  DESCRIPTION_LIMIT,
  internalReport,
  isUntouchedByHuman,
  sensitiveCandidates,
  type BranchChanges,
  type Description,
  type ImageRef,
  type ScreenPair
} from "./describe.js";
import { PAT_ENV, patFromEnv, redactPat, type PatSecret } from "./secret.js";
import { listArchivedTaskDirs, readPrSource, type PrSource } from "./source.js";

export type PrDeps = {
  fetch: FetchImpl;
  env: NodeJS.ProcessEnv;
  /** `git -C <repoRoot> <args>` の stdout。失敗は throw */
  git: (repoRoot: string, args: string[]) => string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type PrOptions = {
  root: string;
  config: WorkflowConfig;
  dryRun?: boolean;
  check?: boolean;
  /** archive のタスクディレクトリ。省略時は最新 */
  taskDir?: string;
};

export type PrOutcome = {
  exitCode: 0 | 1;
  kind: "dry-run" | "checked" | "created" | "updated" | "unchanged" | "skipped" | "failed";
  prId?: number;
};

/** 添付の上限（§B-2）。超えた分は縮退（保存先を書く） */
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** settings.pr に書かれていたら止めるキー（PAT は env のみ）。**値は表示しない** */
const SECRET_KEY = /pat|token|secret|password|credential/i;

type PlannedImage = { file: string; uploadName: string; displayPath: string; bytes: Buffer | null; skipReason: string | null };

export async function runPr(opts: PrOptions, deps: PrDeps): Promise<PrOutcome> {
  const pat = patFromEnv(deps.env);
  const say = (line: string): void => deps.out(redactPat(line, pat));
  const warn = (line: string): void => deps.err(redactPat(line, pat));
  const record = (event: EventType, fields: Record<string, unknown>): void => {
    if (opts.dryRun) return; // --dry-run は Event Log にも書かない（副作用ゼロ）
    appendEvent(opts.root, event, JSON.parse(redactPat(JSON.stringify(fields), pat)) as Record<string, unknown>);
  };

  try {
    const settings = opts.config.settings.pr as PrSettings | undefined;
    const secretKeys = Object.keys(settings ?? {}).filter((k) => SECRET_KEY.test(k));
    if (secretKeys.length > 0) {
      warn(`settings.pr に ${secretKeys.join(", ")} が書かれています。PAT は env ${PAT_ENV} からのみ読みます。workflow.yaml から削除してください（値は表示しません）。`);
      return { exitCode: 1, kind: "failed" };
    }
    if (opts.check) {
      return await runCheck(opts, deps, pat, settings, say, warn, record);
    }
    return await runCreateOrUpdate(opts, deps, pat, settings, say, warn, record);
  } catch (error) {
    const e = error as { message?: string; stage?: string; status?: number | null };
    const message = e.message ?? String(error);
    warn(`aiw pr: 失敗しました — ${message}`);
    record("pr.failed", { stage: e.stage ?? "unknown", status: e.status ?? null, message: message.slice(0, 300) });
    return { exitCode: 1, kind: "failed" };
  }
}

// ---- 接続先・PAT の案内 ------------------------------------------------------------------------

function patGuidance(warn: (l: string) => void): void {
  warn(`env ${PAT_ENV} が設定されていません。`);
  warn("  1. Azure DevOps → User settings → Personal access tokens → New Token");
  warn("     Scopes は Custom defined → Code: Read & Write のみ。有効期限は短く");
  warn(`  2. Windows の「環境変数を編集」（GUI）でユーザー環境変数 ${PAT_ENV} を作り、端末を開き直す`);
  warn("     ⚠️ コマンドライン（setx / $env: / export）で値を打つとシェルの履歴に残ります");
  warn("  ⚠️ PAT の値をチャット・ファイル・コミットに書かないでください");
}

function remoteUrl(opts: PrOptions, deps: PrDeps): string | null {
  const repo = resolveCheckRepoRoot(opts.root, opts.config);
  if (!repo.ok) return null;
  try {
    return deps.git(repo.repoRoot, ["remote", "get-url", "origin"]).trim();
  } catch {
    return null;
  }
}

function settingsSnippet(derived: { organizationUrl: string; project: string; repository: string }): string[] {
  return [
    "settings:",
    "  pr:",
    `    organizationUrl: ${derived.organizationUrl}`,
    `    project: ${JSON.stringify(derived.project)}`,
    `    repository: ${JSON.stringify(derived.repository)}`,
    "    # targetBranch: master   # 省略時はリポジトリの既定ブランチ",
    ...(derived.organizationUrl && !/dev\.azure\.com|visualstudio\.com/i.test(derived.organizationUrl) ? ["    apiVersion: \"<Server の版に合わせる>\""] : [])
  ];
}

async function runCheck(
  opts: PrOptions,
  deps: PrDeps,
  pat: PatSecret | null,
  settings: PrSettings | undefined,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<PrOutcome> {
  let resolved = resolveTarget(settings);
  if (!resolved.ok) {
    const url = remoteUrl(opts, deps);
    const derived = url ? deriveFromRemote(url) : null;
    if (!derived) {
      warn(`settings.pr が足りません: ${resolved.missing.join(", ")}`);
      warn("git remote（origin）からも導出できませんでした。workflow.yaml の settings.pr に書いてください。");
      return { exitCode: 1, kind: "failed" };
    }
    say("settings.pr が未設定のため、git remote（origin）から導出した値で確認します。");
    say("内容を確かめて、runtime の config/workflow.yaml に貼ってください（aiw は workflow.yaml を書き換えません）:");
    say("");
    for (const l of settingsSnippet(derived)) say(`    ${l}`);
    say("");
    resolved = resolveTarget({ ...settings, ...derived });
    if (!resolved.ok) {
      warn(`導出した値でも足りません: ${resolved.missing.join(", ")}`);
      return { exitCode: 1, kind: "failed" };
    }
  }
  if (!pat) {
    patGuidance(warn);
    return { exitCode: 1, kind: "failed" };
  }
  const target = resolved.target;
  say(`接続先: ${target.baseUrl}（${target.kind === "services" ? "Azure DevOps Services" : "Azure DevOps Server"}・api-version ${target.apiVersion}）`);
  const client = new AzdoClient(target, pat, deps.fetch);
  try {
    const repo = await client.getRepository();
    say(`リポジトリ: ${repo.name}（id ${repo.id}・既定ブランチ ${repo.defaultBranch ?? "(なし)"}）`);
    if (repo.webUrl) say(`  ${repo.webUrl}`);
    const prs = await client.listActivePullRequests({ top: 1 });
    say(`PR 一覧の照会: OK（読み取りのみ・${prs.length} 件を取得）`);
    say("書き込みの確認はしていません（客先に見える draft PR をテストで作らないため）。初回の作成は実タスクで --dry-run → 本実行の順に。");
    record("pr.checked", { ok: true, kind: target.kind, apiVersion: target.apiVersion });
    return { exitCode: 0, kind: "checked" };
  } catch (error) {
    const e = error as AzdoError;
    warn(`接続確認に失敗しました — ${e.message}`);
    record("pr.checked", { ok: false, status: e.status ?? null, stage: e.stage ?? null, message: String(e.message).slice(0, 300) });
    return { exitCode: 1, kind: "failed" };
  }
}

// ---- 入力の解決 ------------------------------------------------------------------------------

function resolveTaskDir(opts: PrOptions): string | null {
  if (opts.taskDir) {
    const dir = path.resolve(opts.taskDir);
    return existsSync(path.join(dir, "current-task.md")) ? dir : null;
  }
  return listArchivedTaskDirs(opts.root)[0] ?? null;
}

/** 変更前 → 変更後の順に、対の画像を 1 枚ずつ添付の計画にする（添付名は内容の hash つき = 同じ内容なら同じ名前） */
function planImages(root: string, src: PrSource): PlannedImage[] {
  const base = path.dirname(path.resolve(root));
  const files = src.shots.flatMap((s) => [s.before, s.after].filter((f): f is string => f !== null));
  return files.map((file, i) => {
    const displayPath = path.relative(base, file).replace(/\\/g, "/");
    let bytes: Buffer | null = null;
    let skipReason: string | null = null;
    if (i >= MAX_IMAGES) {
      skipReason = `${MAX_IMAGES} 枚を超えた`;
    } else if (statSync(file).size > MAX_IMAGE_BYTES) {
      skipReason = `${MAX_IMAGE_BYTES / 1024 / 1024}MB を超えた`;
    } else {
      bytes = readFileSync(file);
    }
    const hash = createHash("sha1").update(bytes ?? Buffer.from(file)).digest("hex").slice(0, 8);
    return { file, uploadName: `${path.basename(file).replace(/\.png$/i, "")}.${hash}.png`, displayPath, bytes, skipReason };
  });
}

/** 添付の結果（ファイル → 置き場所）から、説明文の画面の対を作る。結果に無いファイルは保存先へ縮退 */
function screensOf(src: PrSource, planned: PlannedImage[], refs: Map<string, ImageRef>): ScreenPair[] {
  const ref = (file: string | null): ImageRef | null => {
    if (file === null) return null;
    const p = planned.find((x) => x.file === file);
    return refs.get(file) ?? { url: null, displayPath: p?.displayPath ?? file };
  };
  return src.shots.map((s) => ({ name: s.name, before: ref(s.before), after: ref(s.after) }));
}

type LocalBranch = { branch: string | null; reason: string | null; unpushed: number | null };

function localBranch(opts: PrOptions, deps: PrDeps): LocalBranch {
  const repo = resolveCheckRepoRoot(opts.root, opts.config);
  if (!repo.ok) return { branch: null, reason: `検査対象リポジトリを解決できません（${repo.reason}）`, unpushed: null };
  let branch: string;
  try {
    branch = deps.git(repo.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch (error) {
    return { branch: null, reason: `現在のブランチを読めません（${(error as Error).message}）`, unpushed: null };
  }
  if (branch === "HEAD" || branch === "") return { branch: null, reason: "detached HEAD です（ブランチに切り替えてから実行）", unpushed: null };
  let unpushed: number | null = null;
  try {
    unpushed = Number(deps.git(repo.repoRoot, ["rev-list", "--count", "@{u}..HEAD"]).trim());
  } catch {
    unpushed = null; // upstream 未設定
  }
  return { branch, reason: null, unpushed };
}

const heads = (b: string): string => (b.startsWith("refs/heads/") ? b : `refs/heads/${b}`);
const shortName = (b: string): string => b.replace(/^refs\/heads\//, "");

// ---- ブランチの差分（2026-10-23 改訂・§A-2b）。**git の読み取りだけ** ---------------------------------

type ChangesResult = { changes: BranchChanges | null; note: string | null };

/** `--dry-run` の対象ブランチ: settings.pr.targetBranch → origin/HEAD。決められなければ null */
function dryRunTarget(opts: PrOptions, deps: PrDeps, settings: PrSettings | undefined): string | null {
  if (settings?.targetBranch?.trim()) return shortName(settings.targetBranch.trim());
  const repo = resolveCheckRepoRoot(opts.root, opts.config);
  if (!repo.ok) return null;
  try {
    return deps.git(repo.repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().replace(/^origin\//, "") || null;
  } catch {
    return null;
  }
}

/**
 * PR の画面に出る差分と同じ集合: merge-base(origin/<対象>, origin/<ブランチ>) から origin/<ブランチ> まで。
 * 追跡ブランチが無ければローカルの HEAD と比べ、その旨を note に残す（push 前の可能性）。
 */
function branchChanges(opts: PrOptions, deps: PrDeps, branch: string, target: string | null): ChangesResult {
  if (!target) return { changes: null, note: "対象ブランチを決められないため、ブランチの差分を取れませんでした" };
  const repo = resolveCheckRepoRoot(opts.root, opts.config);
  if (!repo.ok) return { changes: null, note: `検査対象リポジトリを解決できません（${repo.reason}）` };
  const g = (args: string[]): string => deps.git(repo.repoRoot, args).trim();
  let ref = `origin/${branch}`;
  let note: string | null = null;
  try {
    g(["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
  } catch {
    ref = "HEAD";
    note = `origin/${branch} が無いため、ローカルの HEAD と比べました（push 前なら PR の差分とずれます）`;
  }
  try {
    const mergeBase = g(["merge-base", `origin/${target}`, ref]);
    const files = g(["diff", "--name-only", mergeBase, ref])
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
    return { changes: { files }, note };
  } catch (error) {
    return { changes: null, note: `ブランチの差分を取れませんでした（origin/${target} との比較: ${(error as Error).message.split(/\r?\n/)[0]}）` };
  }
}

/**
 * archive の宣言にあってブランチの差分に無いファイル。**説明文には書かず stdout にだけ**（黙って落とさない）。
 * 理由は ignore 対象（git check-ignore）か、差分に無い（未コミット・未 push・変更なし）か。
 */
function reportDeclaredGaps(opts: PrOptions, deps: PrDeps, src: PrSource, changes: BranchChanges | null, out: (l: string) => void): void {
  if (changes === null) return;
  if (src.declared === null) {
    out("（突き合わせ: このタスクの変更宣言の記録が無いため省きました）");
    return;
  }
  const inBranch = (f: string): boolean => (f.endsWith("/") ? changes.files.some((c) => c.startsWith(f)) : changes.files.includes(f));
  const missing = src.declared.files.filter((f) => !inBranch(f));
  if (missing.length === 0) return;
  const repo = resolveCheckRepoRoot(opts.root, opts.config);
  const ignored = (f: string): boolean => {
    if (!repo.ok) return false;
    try {
      deps.git(repo.repoRoot, ["check-ignore", "-q", f]);
      return true;
    } catch {
      return false;
    }
  };
  out(`このタスクの変更宣言にあってブランチの差分に無いファイル（${missing.length} 件・説明文には出していません）:`);
  for (const f of missing) out(`  - ${f}（${ignored(f) ? "ignore 対象" : "差分に無い: 未コミット・未 push・変更なしのどれか"}）`);
}

/** 実データらしい語の候補（§A-3 の 2026-10-23 追記）。消さずに並べる */
function reportSensitive(desc: Description, out: (l: string) => void): void {
  const hits = sensitiveCandidates(desc.description);
  if (hits.length === 0) return;
  out(`⚠ 説明文に実データらしい語があります（契約番号・取引先コード・会社名の候補 ${hits.length} 件）。公開前に残すか判断してください:`);
  out(`  ${hits.join(" / ")}`);
}

// ---- 作成 / 更新 -----------------------------------------------------------------------------

async function runCreateOrUpdate(
  opts: PrOptions,
  deps: PrDeps,
  pat: PatSecret | null,
  settings: PrSettings | undefined,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<PrOutcome> {
  const taskDir = resolveTaskDir(opts);
  if (!taskDir) {
    warn(
      opts.taskDir
        ? `--task ${opts.taskDir} にタスクの記録（current-task.md）がありません。`
        : "archive にタスクの記録がありません（reflection の承認後に実行してください）。"
    );
    return { exitCode: 1, kind: "failed" };
  }
  const src = readPrSource(opts.root, taskDir);
  const planned = planImages(opts.root, src);
  const local = localBranch(opts, deps);
  const relTask = path.relative(path.dirname(path.resolve(opts.root)), taskDir).replace(/\\/g, "/");

  if (opts.dryRun) {
    const target = dryRunTarget(opts, deps, settings);
    const diff = local.branch ? branchChanges(opts, deps, local.branch, target) : { changes: null, note: null };
    return dryRun(opts, deps, src, planned, local, settings, target, diff, relTask, say);
  }

  const resolved = resolveTarget(settings);
  if (!resolved.ok) {
    warn(`settings.pr が足りません: ${resolved.missing.join(", ")}`);
    warn("`aiw pr --check` で git remote からの導出値を表示できます。確かめて workflow.yaml に貼ってください。");
    return { exitCode: 1, kind: "failed" };
  }
  if (!pat) {
    patGuidance(warn);
    return { exitCode: 1, kind: "failed" };
  }
  if (!local.branch) {
    warn(`PR を作れません: ${local.reason}`);
    record("pr.skipped", { reason: "branch", detail: local.reason, taskDir: relTask });
    return { exitCode: 1, kind: "skipped" };
  }

  const target = resolved.target;
  const client = new AzdoClient(target, pat, deps.fetch);
  const repo = await client.getRepository();
  const targetBranch = shortName(settings?.targetBranch?.trim() || repo.defaultBranch || "");
  if (!targetBranch) {
    warn("対象ブランチを決められません（リポジトリに既定ブランチが無い）。settings.pr.targetBranch を書いてください。");
    return { exitCode: 1, kind: "failed" };
  }
  if (local.branch === targetBranch) {
    warn(`現在のブランチ（${local.branch}）が対象ブランチと同じです。feature のブランチを作って push してから実行してください。`);
    record("pr.skipped", { reason: "on-target-branch", sourceBranch: local.branch, taskDir: relTask });
    return { exitCode: 1, kind: "skipped" };
  }
  if (!(await client.branchExists(local.branch))) {
    warn(`リモートにブランチ ${local.branch} がありません。\`git push -u origin ${local.branch}\` してから実行してください（aiw は push しません）。`);
    record("pr.skipped", { reason: "branch-not-pushed", sourceBranch: local.branch, taskDir: relTask });
    return { exitCode: 1, kind: "skipped" };
  }
  if (local.unpushed === null) {
    warn(`⚠ ${local.branch} に upstream がありません。リモートとの差は確かめていません。`);
  } else if (local.unpushed > 0) {
    warn(`⚠ ${local.branch} にまだ push していないコミットが ${local.unpushed} 件あります（PR の差分には入りません）。`);
  }

  // ブランチの差分は説明文には出さず（§A-6）、宣言との突き合わせを stdout に出すためだけに取る（§A-2b）
  const diff = branchChanges(opts, deps, local.branch, targetBranch);
  if (diff.note) warn(`⚠ ${diff.note}`);
  reportDeclaredGaps(opts, deps, src, diff.changes, warn);
  const describe = (refs: Map<string, ImageRef>): Description => buildDescription(src, screensOf(src, planned, refs));
  // 添付前の版（画像は全部「保存先」）。作成直後に PATCH が失敗しても、この版が正直な説明文として残る。API の書き込みより前に字数超過で止める
  const initial = describe(new Map());
  if (initial.overLimit) {
    warn(`説明文が ${DESCRIPTION_LIMIT} 字に収まりません（${initial.chars} 字）。PR を作りません。--dry-run で内容を確認してください。`);
    record("pr.failed", { stage: "describe", chars: initial.chars, taskDir: relTask });
    return { exitCode: 1, kind: "failed" };
  }

  const base = { sourceBranch: local.branch, targetBranch, taskDir: relTask };
  const prs = await client.listActivePullRequests({ source: heads(local.branch), target: heads(targetBranch) });
  if (prs.length > 1) {
    warn(`同じブランチの active な PR が ${prs.length} 件あります（#${prs.map((p) => p.pullRequestId).join(", #")}）。どれを更新するか決められないので触りません。`);
    record("pr.skipped", { ...base, reason: "multiple", prIds: prs.map((p) => p.pullRequestId) });
    return { exitCode: 1, kind: "skipped" };
  }

  const prUrl = (id: number): string => (repo.webUrl ? `${repo.webUrl}/pullrequest/${id}` : `#${id}`);
  let outcome: PrOutcome;
  if (prs.length === 0) {
    outcome = await create(client, describe, planned, initial, base, prUrl, say, warn, record);
  } else {
    outcome = await update(client, describe, planned, prs[0], base, prUrl, say, warn, record);
  }
  if (outcome.kind === "created" || outcome.kind === "updated") {
    reportSensitive(initial, warn);
    say("");
    say("公開（draft の解除）は人間の操作です。公開前に確認してください:");
    say("  (1) 画面に実データ・実名が映っていないか  (2) 説明文に内部の用語が残っていないか");
  }
  return outcome;
}

async function attach(
  client: AzdoClient,
  prId: number,
  planned: PlannedImage[],
  existing: Map<string, string>
): Promise<{ refs: Map<string, ImageRef>; failures: string[]; uploaded: number; reused: number }> {
  const refs = new Map<string, ImageRef>();
  const failures: string[] = [];
  let uploaded = 0;
  let reused = 0;
  for (const p of planned) {
    const label = path.basename(p.file);
    if (p.skipReason || !p.bytes) {
      failures.push(`${label}: ${p.skipReason ?? "読めない"}`);
      refs.set(p.file, { url: null, displayPath: p.displayPath });
      continue;
    }
    const known = existing.get(p.uploadName);
    if (known) {
      reused++;
      refs.set(p.file, { url: known, displayPath: p.displayPath });
      continue;
    }
    try {
      const a = await client.uploadAttachment(prId, p.uploadName, p.bytes);
      uploaded++;
      refs.set(p.file, { url: a.url, displayPath: p.displayPath });
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      refs.set(p.file, { url: null, displayPath: p.displayPath });
    }
  }
  return { refs, failures, uploaded, reused };
}

function reportAttachFailures(failures: string[], prId: number, warn: (l: string) => void, record: (e: EventType, f: Record<string, unknown>) => void): void {
  if (failures.length === 0) return;
  warn(`⚠ 画像 ${failures.length} 枚を添付できませんでした。説明文には保存先のパスを書きました（客先からは見えません。公開前に扱いを決めてください）:`);
  for (const f of failures) warn(`  - ${f}`);
  record("pr.attachment-failed", { prId, count: failures.length, reasons: failures.map((f) => f.slice(0, 200)) });
}

async function create(
  client: AzdoClient,
  describe: (refs: Map<string, ImageRef>) => Description,
  planned: PlannedImage[],
  initial: Description,
  base: Record<string, unknown>,
  prUrl: (id: number) => string,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<PrOutcome> {
  const created = await client.createDraftPullRequest({
    source: heads(String(base.sourceBranch)),
    target: heads(String(base.targetBranch)),
    title: initial.title,
    description: initial.description
  });
  const id = created.pullRequestId;
  if (created.isDraft !== true) {
    warn("⚠ 作成した PR が draft になっていません（サーバーの版が draft に対応していない可能性）。公開前の状態か Web で確認してください。");
  }
  let final = initial;
  if (planned.length > 0) {
    const a = await attach(client, id, planned, new Map());
    const withImages = describe(a.refs);
    if (a.uploaded > 0 && !withImages.overLimit) {
      try {
        await client.updateDescription(id, withImages.description);
        final = withImages;
      } catch (error) {
        a.failures.push(`説明文への画像の反映: ${(error as Error).message}`);
      }
    }
    reportAttachFailures(a.failures, id, warn, record);
  }
  record("pr.created", { ...base, prId: id, isDraft: created.isDraft, descriptionChars: final.chars, generationKey: final.generationKey, truncations: final.truncations });
  say(`draft PR を作成しました: ${prUrl(id)}`);
  return { exitCode: 0, kind: "created", prId: id };
}

async function update(
  client: AzdoClient,
  describe: (refs: Map<string, ImageRef>) => Description,
  planned: PlannedImage[],
  listed: AzdoPullRequest,
  base: Record<string, unknown>,
  prUrl: (id: number) => string,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<PrOutcome> {
  const id = listed.pullRequestId;
  const pr = await client.getPullRequest(id); // 一覧の description は 400 字で切れる
  if (!pr.isDraft) {
    warn(`PR ${prUrl(id)} は公開済みです。人間が公開した後の提出物は書き換えません。`);
    record("pr.skipped", { ...base, prId: id, reason: "published" });
    return { exitCode: 1, kind: "skipped", prId: id };
  }
  if (!isUntouchedByHuman(pr.description)) {
    warn(`PR ${prUrl(id)} の説明文は人の手で直されています（生成キーが一致しない）。上書きしません。`);
    warn("新しい説明文は `aiw pr --dry-run` で表示できます。必要な部分を手で反映してください。");
    record("pr.skipped", { ...base, prId: id, reason: "human-edited" });
    return { exitCode: 1, kind: "skipped", prId: id };
  }
  let existing = new Map<string, string>();
  if (planned.length > 0) {
    try {
      existing = new Map((await client.listAttachments(id)).map((a) => [a.displayName, a.url]));
    } catch (error) {
      warn(`⚠ 既存の添付を一覧できませんでした（${(error as Error).message}）。必要な画像は添付し直します。`);
    }
  }
  const a = await attach(client, id, planned, existing);
  const desc = describe(a.refs);
  if (desc.overLimit) {
    warn(`説明文が ${DESCRIPTION_LIMIT} 字に収まりません（${desc.chars} 字）。更新しません。`);
    record("pr.failed", { ...base, prId: id, stage: "describe", chars: desc.chars });
    return { exitCode: 1, kind: "failed", prId: id };
  }
  reportAttachFailures(a.failures, id, warn, record);
  const norm = (s: string): string => s.replace(/\r\n/g, "\n").trim();
  if (norm(desc.description) === norm(pr.description)) {
    record("pr.updated", { ...base, prId: id, unchanged: true, generationKey: desc.generationKey });
    say(`draft PR の説明文は最新です（変更なし）: ${prUrl(id)}`);
    return { exitCode: 0, kind: "unchanged", prId: id };
  }
  await client.updateDescription(id, desc.description);
  record("pr.updated", { ...base, prId: id, descriptionChars: desc.chars, generationKey: desc.generationKey, truncations: desc.truncations, attachmentsUploaded: a.uploaded, attachmentsReused: a.reused });
  say(`draft PR の説明文を更新しました: ${prUrl(id)}`);
  return { exitCode: 0, kind: "updated", prId: id };
}

// ---- --dry-run ------------------------------------------------------------------------------

function dryRun(
  opts: PrOptions,
  deps: PrDeps,
  src: PrSource,
  planned: PlannedImage[],
  local: LocalBranch,
  settings: PrSettings | undefined,
  target: string | null,
  diff: ChangesResult,
  relTask: string,
  say: (l: string) => void
): PrOutcome {
  const refs = new Map<string, ImageRef>(
    planned.map((p) => [p.file, { url: p.skipReason ? null : `<${p.uploadName} の添付後の URL>`, displayPath: p.displayPath }])
  );
  const desc = buildDescription(src, screensOf(src, planned, refs));
  const resolved = resolveTarget(settings);
  say("=== aiw pr --dry-run（API は呼びません。Event Log にも書きません）===");
  say(`入力（タスクの記録）: ${relTask}${src.taskId ? `（${src.taskId}）` : ""}`);
  say(`接続先: ${resolved.ok ? `${resolved.target.baseUrl} / ${resolved.target.project} / ${resolved.target.repository}（api-version ${resolved.target.apiVersion}）` : `未設定（${resolved.missing.join(", ")}）`}`);
  say(`ソースブランチ: ${local.branch ?? `決められない（${local.reason}）`}`);
  say(`対象ブランチ: ${target ? `${target}${settings?.targetBranch?.trim() ? "" : "（origin/HEAD から。本実行ではリポジトリの既定ブランチを照会）"}` : "決められない（本実行でリポジトリの既定ブランチを照会）"}`);
  if (diff.note) say(`⚠ ${diff.note}`);
  reportDeclaredGaps(opts, deps, src, diff.changes, say);
  reportSensitive(desc, say);
  say("--- 内部の確認結果（説明文には出しません）---");
  for (const l of internalReport(src, diff.changes)) say(l);
  if (src.requested !== null && src.requested.length === 0) {
    say("⚠ 依頼文（user-task.md）にチェックボックスの項目が無いため、「対応した内容」は作業記録の要約で代えています");
  }
  const unpaired = src.shots.filter((s) => s.before === null || s.after === null).map((s) => `${s.name}（${s.before === null ? "変更前" : "変更後"}なし）`);
  if (unpaired.length > 0) say(`⚠ 対になっていない画面: ${unpaired.join(" / ")}`);
  say("---");
  say("実行予定の操作:");
  say("  1. 同じソース・対象ブランチの active な PR を照会");
  say("  2a. 無ければ draft PR を作成（タイトル・説明文）");
  say("  2b. 1 件・draft・生成キー一致なら説明文だけ更新（タイトルは触らない）/ 公開済み・人が直した・複数なら触らない");
  if (planned.length > 0) {
    say(`  3. 画像の添付（${planned.length} 枚・同名の添付があれば再利用）:`);
    for (const p of planned) say(`     - ${p.uploadName}${p.skipReason ? `（添付しない: ${p.skipReason}）` : ""}`);
  } else {
    say("  3. 画像の添付: なし（feature の各タスクの runs/<Task ID>/screenshots/ に before-* / after-* が無い）");
  }
  say(`タイトル（作成時のみ）: ${desc.title}`);
  say(`説明文: ${desc.chars} / ${DESCRIPTION_LIMIT} 字${desc.overLimit ? "（⚠ 上限超過。本実行では作りません）" : ""}${desc.truncations.length > 0 ? `・削った節: ${desc.truncations.join(", ")}` : ""}`);
  say(`内部用語の残り（自由記述の英字の語）: ${desc.leftoverJargon} 語${desc.leftoverJargon > 0 ? "（公開前に人が直す想定）" : ""}`);
  say("----- 説明文 -----");
  for (const l of desc.description.split("\n")) say(l);
  say("------------------");
  return { exitCode: 0, kind: "dry-run" };
}
