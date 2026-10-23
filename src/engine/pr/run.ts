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
import { readEventLog } from "../observed.js";
import type { PrSettings, WorkflowConfig } from "../types.js";
import { AzdoClient, AzdoError, deriveFromRemote, resolveTarget, type AzdoPullRequest, type FetchImpl } from "./azdo.js";
import {
  buildDescription,
  buildReplyComment,
  buildScreensComment,
  parseReplyComment,
  DESCRIPTION_LIMIT,
  headingsWithoutScreens,
  internalReport,
  isScreensComment,
  placeScreens,
  isUntouchedByHuman,
  sensitiveCandidates,
  type BranchChanges,
  type Description,
  type ImageRef,
  type ScreenPair
} from "./describe.js";
import { PAT_ENV, patFromEnv, redactPat, type PatSecret } from "./secret.js";
import { branchKey, listArchivedTaskDirs, readPrSource, taskDirKey, type PrSource } from "./source.js";

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
  /** 指摘への対応（第 n 回）のコメントを既存の PR に投稿する（2026-10-23・§I） */
  reply?: boolean;
  /** archive のタスクディレクトリ。省略時は最新 */
  taskDir?: string;
};

export type PrOutcome = {
  exitCode: 0 | 1;
  kind: "dry-run" | "checked" | "created" | "updated" | "unchanged" | "skipped" | "failed";
  prId?: number;
};

/**
 * 添付の上限（§B-2）。超えた分は縮退（保存先を書く）。
 * 2026-10-23: 10 → 60。10 は画像を説明文（4000 字）に載せていた頃の上限で、コメントへ移した（§A-6c）後は意味が無かった
 * （実例: タブごとに 10 対 20 枚撮り、11 枚目以降の 10 枚が添付されなかった）。60 は「タブ 15 × 全体と右側 × 変更前後」程度の余裕で、
 * 誤って大量の画像を置いたときに止める歯止めとして残す
 */
const MAX_IMAGES = 60;
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
    if (opts.reply) {
      return await runReply(opts, deps, pat, settings, say, warn, record);
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

/**
 * 説明文の元にするタスクの記録（2026-10-23・設計 §E-5）。
 * `--task` が無ければ、**今のブランチに対応する feature（単一タスクは Task ID）の、一番新しいタスク**。
 * 以前は「archive の一番新しいタスク」だったので、別の feature のブランチで打つと別の feature の記録で PR を作った（実例: 1023 のブランチで 1022 の記録）。
 * 見つからなければ null（**黙って別の記録を使わない**）。`--task` がブランチと合わないときは警告だけ（人間が明示したので使う）。
 */
function resolveTaskDir(opts: PrOptions, branch: string | null): { dir: string | null; warning: string | null; error: string | null } {
  if (opts.taskDir) {
    const dir = path.resolve(opts.taskDir);
    if (!existsSync(path.join(dir, "current-task.md"))) {
      return { dir: null, warning: null, error: `--task ${opts.taskDir} にタスクの記録（current-task.md）がありません。` };
    }
    const key = taskDirKey(dir);
    const warning =
      branch && key !== branchKey(branch) ? `--task の記録（${key ?? "不明"}）は今のブランチ（${branch}）と名前が合いません。指定どおりこの記録を使います。` : null;
    return { dir, warning, error: null };
  }
  if (!branch) {
    return { dir: null, warning: null, error: "今のブランチが決まらないため、どのタスクの記録を使うか決められません。--task で指定してください。" };
  }
  const want = branchKey(branch);
  const dir = listArchivedTaskDirs(opts.root).find((d) => taskDirKey(d) === want) ?? null;
  if (!dir) {
    return {
      dir: null,
      warning: null,
      error:
        `ブランチ ${branch} に対応するタスクの記録が archive にありません（feature ID が「FEAT-${want}」の記録を探しました）。` +
        "reflection の承認後に打つか、--task で記録のフォルダを指定してください。ブランチ名は feature ID から付けます（例: FEAT-x → feature/x）。"
    };
  }
  return { dir, warning: null, error: null };
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
  return src.shots.map((s) => ({ name: s.name, before: ref(s.before), after: ref(s.after), label: s.label }));
}

/** スクショの足りなさ（§A-6b）: 比較の画像が無い依頼の見出しと、ラベルの無い / 見出しに当たらない画像。**PR を作る前に気づくため** */
function reportShotCoverage(src: PrSource, out: (l: string) => void): void {
  const screens: ScreenPair[] = src.shots.map((s) => ({ name: s.name, before: null, after: null, label: s.label }));
  const missing = headingsWithoutScreens(src, screens);
  if (missing.length > 0) out(`⚠ 比較のスクショが無い見出し（${missing.length} 件）: ${missing.join("、")}`);
  const headings = (src.requested ?? []).map((g) => g.heading);
  const { rest } = placeScreens(headings, screens);
  const stray = rest.map((s) => (s.label ? `${s.name}（ラベル「${s.label}」が見出しに当たらない）` : `${s.name}（labels.json にラベルが無い）`));
  if (headings.length > 0 && stray.length > 0) out(`⚠ 見出しの下に置けない画像（「画面」節にまとめます）: ${stray.join("、")}`);
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
  const local = localBranch(opts, deps);
  if (!local.branch) {
    warn(`PR を作れません: ${local.reason}`);
    record("pr.skipped", { reason: "branch", detail: local.reason });
    return { exitCode: 1, kind: "skipped" };
  }
  // 対象ブランチの上で打った（今の運用で一番ありうる）なら、記録を探す前にそう言う（git の読み取りだけで分かる範囲）
  const localTarget = dryRunTarget(opts, deps, settings);
  if (localTarget && local.branch === localTarget) {
    warn(`現在のブランチ（${local.branch}）が対象ブランチと同じです。feature のブランチを作って push してから実行してください。`);
    record("pr.skipped", { reason: "on-target-branch", sourceBranch: local.branch });
    return { exitCode: 1, kind: "skipped" };
  }
  const picked = resolveTaskDir(opts, local.branch);
  if (!picked.dir) {
    warn(picked.error ?? "タスクの記録を決められません。");
    record("pr.skipped", { reason: "no-task-record-for-branch", sourceBranch: local.branch });
    return { exitCode: 1, kind: "skipped" };
  }
  if (picked.warning) warn(`⚠ ${picked.warning}`);
  const taskDir = picked.dir;
  const src = readPrSource(opts.root, taskDir);
  const planned = planImages(opts.root, src);
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
  // 説明文はテキストだけ（§A-6c）。画像は PR のコメントへ（添付の URL が長く、タブごとに撮ると 4000 字に収まらない）。
  // API の書き込みより前に字数超過で止める
  const initial = buildDescription(src, screensOf(src, planned, new Map()));
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
  const outcome = prs.length === 0 ? await create(client, initial, base, prUrl, say, warn, record) : await update(client, initial, prs[0], base, prUrl, say, warn, record);
  if (outcome.prId !== undefined && (outcome.kind === "created" || outcome.kind === "updated" || outcome.kind === "unchanged")) {
    // 画像のコメントは説明文と独立に作る / 更新する。失敗しても PR は残る（report）
    await syncScreens(client, outcome.prId, src, planned, outcome.kind !== "created", base, say, warn, record);
    reportSensitive(initial, warn);
    reportShotCoverage(src, warn);
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
  warn(`⚠ 画像 ${failures.length} 枚を添付できませんでした。コメントには保存先のパスを書きました（客先からは見えません。公開前に扱いを決めてください）:`);
  for (const f of failures) warn(`  - ${f}`);
  record("pr.attachment-failed", { prId, count: failures.length, reasons: failures.map((f) => f.slice(0, 200)) });
}

/**
 * 画像のコメント（§A-6c）: 添付してから、aiw のコメント（見出しと生成キーの行がある）を探して作る / 更新する。
 * 人が直したコメント・aiw のコメントが複数ある場合は触らない（説明文と同じ規則）。どの失敗も PR の作成・更新を取り消さない（report）
 */
async function syncScreens(
  client: AzdoClient,
  prId: number,
  src: PrSource,
  planned: PlannedImage[],
  existingPr: boolean,
  base: Record<string, unknown>,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<void> {
  if (planned.length === 0) return;
  try {
    let existing = new Map<string, string>();
    if (existingPr) {
      try {
        existing = new Map((await client.listAttachments(prId)).map((a) => [a.displayName, a.url]));
      } catch (error) {
        warn(`⚠ 既存の添付を一覧できませんでした（${(error as Error).message}）。必要な画像は添付し直します。`);
      }
    }
    const a = await attach(client, prId, planned, existing);
    reportAttachFailures(a.failures, prId, warn, record);
    const comment = buildScreensComment(src, screensOf(src, planned, a.refs));
    if (comment === null) return;
    const mine = (await client.listThreads(prId)).filter((t) => isScreensComment(t.content));
    const fields = { ...base, prId, generationKey: comment.generationKey, chars: comment.chars, attachmentsUploaded: a.uploaded, attachmentsReused: a.reused };
    if (mine.length === 0) {
      await client.createThread(prId, comment.content);
      record("pr.screens", { ...fields, action: "created" });
      say("画面（変更前 → 変更後）のコメントを作りました。");
    } else if (mine.length > 1) {
      warn(`⚠ aiw の画面のコメントが ${mine.length} 件あります。どれを更新するか決められないので触りません。`);
      record("pr.screens", { ...fields, action: "skipped", reason: "multiple" });
    } else if (!isUntouchedByHuman(mine[0].content)) {
      warn("⚠ 画面のコメントは人の手で直されています（生成キーが一致しない）。上書きしません。");
      record("pr.screens", { ...fields, action: "skipped", reason: "human-edited" });
    } else if (mine[0].content.replace(/\r\n/g, "\n").trim() === comment.content.trim()) {
      record("pr.screens", { ...fields, action: "unchanged" });
      say("画面のコメントは最新です（変更なし）。");
    } else {
      await client.updateComment(prId, mine[0].id, mine[0].commentId, comment.content);
      record("pr.screens", { ...fields, action: "updated" });
      say("画面のコメントを更新しました。");
    }
  } catch (error) {
    const e = error as { message?: string; status?: number | null };
    warn(`⚠ 画面のコメントを作れませんでした（PR はそのままです）: ${e.message ?? String(error)}`);
    record("pr.attachment-failed", { prId, stage: "comment", status: e.status ?? null, message: String(e.message ?? error).slice(0, 300) });
  }
}

async function create(
  client: AzdoClient,
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
  record("pr.created", { ...base, prId: id, isDraft: created.isDraft, descriptionChars: initial.chars, generationKey: initial.generationKey, truncations: initial.truncations });
  say(`draft PR を作成しました: ${prUrl(id)}`);
  return { exitCode: 0, kind: "created", prId: id };
}

async function update(
  client: AzdoClient,
  desc: Description,
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
  const norm = (s: string): string => s.replace(/\r\n/g, "\n").trim();
  if (norm(desc.description) === norm(pr.description)) {
    record("pr.updated", { ...base, prId: id, unchanged: true, generationKey: desc.generationKey });
    say(`draft PR の説明文は最新です（変更なし）: ${prUrl(id)}`);
    return { exitCode: 0, kind: "unchanged", prId: id };
  }
  await client.updateDescription(id, desc.description);
  record("pr.updated", { ...base, prId: id, descriptionChars: desc.chars, generationKey: desc.generationKey, truncations: desc.truncations });
  say(`draft PR の説明文を更新しました: ${prUrl(id)}`);
  return { exitCode: 0, kind: "updated", prId: id };
}

// ---- 指摘への対応（第 n 回）: --reply（2026-10-23・設計 §I）----------------------------------------
//
// 運用（人間の判断）: 指摘は同じブランチ・同じ PR で直す。指摘 1 回分 = 単一タスク 1 本（依頼文に指摘をチェックボックスで）。
// 公開済みの説明文と画面のコメントは書き換えず、回ごとに「指摘への対応（第 n 回）」のコメントを足す。
// 投稿は人間が --reply を打ったときだけ（--dry-run で内容を見てから。客先から見える書き込みなので、打つことを署名とみなす）。

const stampOf = (dir: string): string => path.basename(dir).match(/^(\d{8}T\d{6})-/)?.[1] ?? "";

/** このブランチで報告済みのタスク（pr.created / pr.updated / pr.reply の taskDir）。Event Log から */
function reportedTasks(root: string, branch: string): { dirs: string[]; replies: number; replyDirs: string[] } {
  const log = readEventLog(root);
  if (log === "missing" || log === "unreadable") return { dirs: [], replies: 0, replyDirs: [] };
  const dirs = new Set<string>();
  const replyTasks = new Set<string>();
  const replyDirs = new Set<string>();
  for (const r of log) {
    if (!["pr.created", "pr.updated", "pr.reply"].includes(String(r.event)) || r.sourceBranch !== branch) continue;
    if (typeof r.taskDir !== "string") continue;
    if (r.event === "pr.reply") {
      if (r.action === "skipped") continue; // 投稿していない回は報告に数えない
      replyDirs.add(r.taskDir);
      if (r.action === "created") replyTasks.add(r.taskDir);
    }
    dirs.add(r.taskDir);
  }
  return { dirs: [...dirs], replies: replyTasks.size, replyDirs: [...replyDirs] };
}

/**
 * その回のタスク: --task が無ければ、このブランチで最後に報告したタスクより後に archive されたタスク。
 * 1 本ならそれ。0 本・複数なら止まる（黙って選ばない）。単一タスクも feature のタスクも候補にする
 */
function pickReplyTask(opts: PrOptions, branch: string): { dir: string | null; error: string | null } {
  if (opts.taskDir) {
    const dir = path.resolve(opts.taskDir);
    return existsSync(path.join(dir, "current-task.md")) ? { dir, error: null } : { dir: null, error: `--task ${opts.taskDir} にタスクの記録（current-task.md）がありません。` };
  }
  const { dirs: reported, replyDirs } = reportedTasks(opts.root, branch);
  if (reported.length === 0) {
    return { dir: null, error: `ブランチ ${branch} では、まだ aiw pr で PR を作った記録がありません。先に \`aiw pr\` で PR を作ってください。` };
  }
  const last = reported.map(stampOf).sort().pop() ?? "";
  const base = path.dirname(path.resolve(opts.root));
  const reportedAbs = new Set(reported.map((d) => path.resolve(base, d)));
  const candidates = listArchivedTaskDirs(opts.root).filter((d) => stampOf(d) > last && !reportedAbs.has(path.resolve(d)));
  if (candidates.length === 1) return { dir: candidates[0], error: null };
  const rel = (d: string): string => path.relative(base, d).replace(/\\/g, "/");
  // 新しいタスクが無く、最後の報告が回のコメントなら、打ち直し = その回のコメントの更新（同じタスク）
  const lastReply = replyDirs.sort((x, y) => (stampOf(x) < stampOf(y) ? -1 : 1)).pop();
  if (candidates.length === 0 && lastReply && stampOf(lastReply) === last) {
    return { dir: path.resolve(base, lastReply), error: null };
  }
  if (candidates.length === 0) {
    return { dir: null, error: `前回の報告（${last}）より後に終わったタスクの記録がありません。指摘への対応のタスクを reflection まで終えてから打ってください。` };
  }
  return { dir: null, error: `前回の報告より後のタスクが ${candidates.length} 本あります。--task で選んでください:\n${candidates.map((d) => `  - ${rel(d)}`).join("\n")}` };
}

async function runReply(
  opts: PrOptions,
  deps: PrDeps,
  pat: PatSecret | null,
  settings: PrSettings | undefined,
  say: (l: string) => void,
  warn: (l: string) => void,
  record: (e: EventType, f: Record<string, unknown>) => void
): Promise<PrOutcome> {
  const local = localBranch(opts, deps);
  if (!local.branch) {
    warn(`指摘への対応を投稿できません: ${local.reason}`);
    return { exitCode: 1, kind: "skipped" };
  }
  const picked = pickReplyTask(opts, local.branch);
  if (!picked.dir) {
    warn(picked.error ?? "その回のタスクの記録を決められません。");
    return { exitCode: 1, kind: "skipped" };
  }
  const src = readPrSource(opts.root, picked.dir, { ownShotsOnly: true });
  const planned = planImages(opts.root, src);
  const relTask = path.relative(path.dirname(path.resolve(opts.root)), picked.dir).replace(/\\/g, "/");

  if (opts.dryRun) {
    const round = reportedTasks(opts.root, local.branch).replies + 1;
    const refs = new Map<string, ImageRef>(planned.map((p) => [p.file, { url: p.skipReason ? null : `<${p.uploadName} の添付後の URL>`, displayPath: p.displayPath }]));
    const comment = buildReplyComment(src, screensOf(src, planned, refs), round);
    say("=== aiw pr --reply --dry-run（API は呼びません。Event Log にも書きません）===");
    say(`ブランチ: ${local.branch}`);
    say(`その回のタスク: ${relTask}${src.taskId ? `（${src.taskId}）` : ""}`);
    say(`回の番号: 第 ${round} 回（本実行では PR の既存のコメントから決める）`);
    say(`画像: ${planned.length} 枚（このタスクの runs/<Task ID>/screenshots/ だけ）`);
    reportShotCoverage(src, say);
    const hits = sensitiveCandidates(comment.content);
    if (hits.length > 0) say(`⚠ 実データらしい語: ${hits.join(" / ")}`);
    say("投稿先: このブランチの active な PR（draft でも公開済みでも）。説明文と画面のコメントには触りません");
    say(`----- コメント（指摘への対応）: ${comment.chars} 字 -----`);
    for (const l of comment.content.split("\n")) say(l);
    say("------------------");
    return { exitCode: 0, kind: "dry-run" };
  }

  const resolved = resolveTarget(settings);
  if (!resolved.ok) {
    warn(`settings.pr が足りません: ${resolved.missing.join(", ")}`);
    return { exitCode: 1, kind: "failed" };
  }
  if (!pat) {
    patGuidance(warn);
    return { exitCode: 1, kind: "failed" };
  }
  const client = new AzdoClient(resolved.target, pat, deps.fetch);
  const repo = await client.getRepository();
  const targetBranch = shortName(settings?.targetBranch?.trim() || repo.defaultBranch || "");
  const prs = await client.listActivePullRequests({ source: heads(local.branch), target: heads(targetBranch) });
  const base = { sourceBranch: local.branch, targetBranch, taskDir: relTask };
  if (prs.length !== 1) {
    warn(prs.length === 0 ? `ブランチ ${local.branch} の active な PR がありません。先に \`aiw pr\` で作ってください。` : `同じブランチの active な PR が ${prs.length} 件あります。どれに投稿するか決められないので触りません。`);
    record("pr.reply", { ...base, action: "skipped", reason: prs.length === 0 ? "no-pr" : "multiple" });
    return { exitCode: 1, kind: "skipped" };
  }
  const prId = prs[0].pullRequestId;
  const prUrl = repo.webUrl ? `${repo.webUrl}/pullrequest/${prId}` : `#${prId}`;

  let existing = new Map<string, string>();
  if (planned.length > 0) {
    try {
      existing = new Map((await client.listAttachments(prId)).map((a) => [a.displayName, a.url]));
    } catch (error) {
      warn(`⚠ 既存の添付を一覧できませんでした（${(error as Error).message}）。必要な画像は添付し直します。`);
    }
  }
  const a = await attach(client, prId, planned, existing);
  reportAttachFailures(a.failures, prId, warn, record);
  const screens = screensOf(src, planned, a.refs);
  const replies = (await client.listThreads(prId)).map((t) => ({ t, parsed: parseReplyComment(t.content) })).filter((x) => x.parsed !== null);
  const mine = replies.filter((x) => x.parsed!.taskId === src.taskId);
  const fields = { ...base, prId, attachmentsUploaded: a.uploaded, attachmentsReused: a.reused };

  let kind: PrOutcome["kind"];
  if (mine.length === 0) {
    const round = Math.max(0, ...replies.map((x) => x.parsed!.round)) + 1;
    const comment = buildReplyComment(src, screens, round);
    await client.createThread(prId, comment.content);
    record("pr.reply", { ...fields, action: "created", round, generationKey: comment.generationKey, chars: comment.chars });
    say(`指摘への対応（第 ${round} 回）のコメントを投稿しました: ${prUrl}`);
    kind = "created";
  } else if (mine.length > 1) {
    warn(`⚠ このタスク（${src.taskId}）の回のコメントが ${mine.length} 件あります。どれを更新するか決められないので触りません。`);
    record("pr.reply", { ...fields, action: "skipped", reason: "multiple" });
    return { exitCode: 1, kind: "skipped", prId };
  } else if (!isUntouchedByHuman(mine[0].t.content)) {
    warn("⚠ この回のコメントは人の手で直されています（生成キーが一致しない）。上書きしません。");
    record("pr.reply", { ...fields, action: "skipped", reason: "human-edited", round: mine[0].parsed!.round });
    return { exitCode: 1, kind: "skipped", prId };
  } else {
    const round = mine[0].parsed!.round;
    const comment = buildReplyComment(src, screens, round);
    if (mine[0].t.content.replace(/\r\n/g, "\n").trim() === comment.content.trim()) {
      record("pr.reply", { ...fields, action: "unchanged", round });
      say(`指摘への対応（第 ${round} 回）のコメントは最新です（変更なし）。`);
      kind = "unchanged";
    } else {
      await client.updateComment(prId, mine[0].t.id, mine[0].t.commentId, comment.content);
      record("pr.reply", { ...fields, action: "updated", round, generationKey: comment.generationKey, chars: comment.chars });
      say(`指摘への対応（第 ${round} 回）のコメントを更新しました: ${prUrl}`);
      kind = "updated";
    }
  }
  reportShotCoverage(src, warn);
  if (!prs[0].isDraft) say("⚠ この PR は公開済みです。投稿したコメントは客先から見えます（画面に実データ・実名が映っていないか確認してください）。");
  return { exitCode: 0, kind, prId };
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
  reportShotCoverage(src, say);
  const unpaired = src.shots.filter((s) => s.before === null || s.after === null).map((s) => `${s.name}（${s.before === null ? "変更前" : "変更後"}なし）`);
  if (unpaired.length > 0) say(`⚠ 対になっていない画面: ${unpaired.join(" / ")}`);
  say("---");
  say("実行予定の操作:");
  say("  1. 同じソース・対象ブランチの active な PR を照会");
  say("  2a. 無ければ draft PR を作成（タイトル・説明文）");
  say("  2b. 1 件・draft・生成キー一致なら説明文だけ更新（タイトルは触らない）/ 公開済み・人が直した・複数なら触らない");
  const comment = buildScreensComment(src, screensOf(src, planned, refs));
  // 添付しない画像は一覧の中に埋もれて見落とされた（2026-10-23: 20 枚中 10 枚）。件数と理由を ⚠ で出す
  const skipped = planned.filter((p) => p.skipReason);
  if (skipped.length > 0) {
    say(`⚠ 添付しない画像が ${skipped.length} 枚あります（コメントには保存先のパスを書きます）: ${[...new Set(skipped.map((p) => p.skipReason))].join("、")}`);
  }
  if (planned.length > 0) {
    say(`  3. 画像の添付（${planned.length} 枚・同名の添付があれば再利用）:`);
    for (const p of planned) say(`     - ${p.uploadName}${p.skipReason ? `（添付しない: ${p.skipReason}）` : ""}`);
    say("  4. 画面のコメント「画面（変更前 → 変更後）」を作る / aiw のコメントがあり人が直していなければ更新（説明文と同じ規則）");
  } else {
    say("  3. 画像の添付: なし（feature の各タスクの runs/<Task ID>/screenshots/ に before-* / after-* が無い）");
  }
  say(`タイトル（作成時のみ）: ${desc.title}`);
  say(`説明文: ${desc.chars} / ${DESCRIPTION_LIMIT} 字${desc.overLimit ? "（⚠ 上限超過。本実行では作りません）" : ""}${desc.truncations.length > 0 ? `・削った節: ${desc.truncations.join(", ")}` : ""}`);
  say(`内部用語の残り（自由記述の英字の語）: ${desc.leftoverJargon} 語${desc.leftoverJargon > 0 ? "（公開前に人が直す想定）" : ""}`);
  say("----- 説明文 -----");
  for (const l of desc.description.split("\n")) say(l);
  say("------------------");
  if (comment) {
    say(`----- コメント（画面）: ${comment.chars} 字 -----`);
    for (const l of comment.content.split("\n")) say(l);
    say("------------------");
  }
  return { exitCode: 0, kind: "dry-run" };
}
