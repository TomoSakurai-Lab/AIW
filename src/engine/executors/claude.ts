// claude executor（M4 段階1）。設計は docs/design-claude-executor.md が正本。
//
// 契約(types.ts)のうち、この executor で特に効くもの:
//   - state.json を触らない。validator を呼ばない。遷移を判定しない
//   - **成果物を検証しない**。current-status.json 等は Claude がファイルへ書き、
//     当否は `aiw run` の validator が決める
//
// codex.ts とは**共通化しない**（前提2）。2 実装が揃ってから M4.4 で抽出を判定する。
// 似て見える箇所（spawn / tee / usage 転記）も、まずは独立に書いて差を観測する。
//
// 実測に基づく設計判断（詳細は設計文書「調査結果」）:
//   - プロンプトは **stdin**（§4 実測。空 stdin + 引数なしは即エラーになる＝黙って空で走らない）
//   - **shell を経由しない**。`claude.exe` は exe なので直接 spawn できる（codex の JS シム迂回は不要）
//   - **exit code を成功判定に使わない**。permission 拒否でも `is_error:false` / exit 0 が返る
//     ことを実測済み（§9-2）。成否の正は `result.is_error`、成果物の当否は validator
//   - **`Write` は `--tools` に渡さない**。`Write(path)` のパスルールは監視されないことを実測
//     （§9-2）。書き込みは `Edit` で行い、許可は**成果物ファイルの列挙**にする
//   - CLAUDE_CONFIG_DIR を隔離する。env は**許可リスト方式**で組む（拒否リストでは
//     知らない変数名を塞げない。実測: 親セッションの ANTHROPIC_BASE_URL / CLAUDE_EFFORT が実在した）
//   - **タイマーを持たない**。総上限と無進行の見張りは engine/watchdog.ts が担う。
//     ここは `req.timeoutMs` と `req.signal` を配線するだけ（二重管理を作らない）
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { assembleStepPrompt } from "../promptAssembly.js";
import { rootPaths } from "../paths.js";
import { resolveCheckRepoRoot } from "../gitScope.js";
import { redactSession, sessionSecret, toSessionRef, type SessionRef, type SessionSecret } from "../session.js";
import type { ExecutorName, WorkflowStep } from "../types.js";
import type { ExecutorProgress, ExecutorRequest, ExecutorResult, StepExecutor } from "./types.js";

/** 既定タイムアウト。review の実測中央値 13 分に対して 3 倍（設計 課題F）。
 *  ⚠️ 通常は engine が解決した `req.timeoutMs` が来るので、ここが効くのは直接呼び出しのときだけ。 */
export const CLAUDE_DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * 子プロセスへ渡す env の**許可リスト**（設計 課題D）。
 *
 * ⚠️ **拒否リストにしない。** 「ANTHROPIC_* と CLAUDE_* を除く」では、知らない変数名
 * （将来増える設定・別経路の資格情報）を塞げない。渡すものを列挙し、それ以外は落とす。
 * 実測: この開発環境の env には ANTHROPIC_BASE_URL / CLAUDECODE / CLAUDE_EFFORT が実在した
 * ——aiw が Claude Code の配下で動く限り必ず起きる漏れ経路。
 *
 * 照合は**大文字小文字を無視**する（Windows の env 名は大小混在で入っている）。
 */
export const CLAUDE_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "USERNAME",
  "USERDOMAIN",
  "LANG",
  "LC_ALL",
  "TZ"
] as const;

export type ClaudeDeps = {
  /** テスト用の差し替え口。既定は pin した claude.exe を shell 無しで直接起動する */
  launch?: (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ClaudeProcess;
  now?: () => number;
};

export type ClaudeProcess = {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): void;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

/**
 * pin した claude 実行体の絶対パス。
 *
 * `bin/claude.exe`（Windows）か `bin/claude`（他 OS）。**実在する方**を返し、
 * どちらも無ければプラットフォーム既定を返す（不在の報告は execute 側が行う）。
 */
export function claudeEntrypoint(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const bin = path.resolve(here, "..", "..", "..", "node_modules", "@anthropic-ai", "claude-code", "bin");
  const exe = path.join(bin, "claude.exe");
  const plain = path.join(bin, "claude");
  if (existsSync(exe)) {
    return exe;
  }
  if (existsSync(plain)) {
    return plain;
  }
  return process.platform === "win32" ? exe : plain;
}

/**
 * 自動更新が pin を壊した痕跡（`claude.exe.old.<epoch>`）を探す。
 *
 * 実測（2026-09-01）: 実体が `.old.<epoch ms>` へ改名されたまま新しい実体が置かれず、
 * `bin/claude.exe` が消えた。**`npm ls` は正常を報告し続ける**ので版の照合では見つからない。
 * 復旧は改名を戻すだけでよかったので、案内できるようにここで拾う。
 */
export function findStaleBinaries(entry: string): string[] {
  const dir = path.dirname(entry);
  const base = path.basename(entry);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.old.`))
      .sort();
  } catch {
    return [];
  }
}

/** 隔離 CLAUDE_CONFIG_DIR の絶対パス。既定は runtimeRoot 配下の `.claude-home`。 */
export function resolveClaudeHome(root: string, declared?: string): string {
  const value = declared && declared.trim() !== "" ? declared : ".claude-home";
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * Windows のパスを permission rule が解釈できる POSIX 絶対形へ正規化する。
 *
 * `C:\Users\…` → `//c/Users/…`。実測（§9-2）:
 *   - バックスラッシュ絶対パスのルールは**効かない**（内も外も拒否された）
 *   - 絶対のアンカーは `//`。`/path` は「設定ソースからの相対」という別の意味になる
 */
export function toPosixAbsolute(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\/(.*)$/.exec(abs);
  return drive ? `//${drive[1].toLowerCase()}/${drive[2]}` : abs;
}

/**
 * パスを OS が持つ**正式な表記**へ直す（Windows の 8.3 短縮名・シンボリックリンクを畳む）。
 *
 * ⚠️ **実測で必要と分かった**（2026-09-04 のスモーク）。許可ルールの照合は文字列比較なので、
 * こちらが `//c/Users/TOMO~1.SAK/…`（短縮名）を渡すと、Claude 側が解決した
 * `//c/Users/tomo.sakurai/…` と一致せず **Edit が拒否される**。
 * 拒否は permission_denials に残るので気付けたが、気付かなければ
 * 「書けないのに exit 0」で終わる形だった。
 *
 * 実在しないパスでは失敗するので、**存在する root に対してだけ**呼ぶこと。
 */
function longPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Edit を許可する対象（root 相対）。**出どころは `steps.<id>.outputs` の宣言**。
 *
 * ⚠️ 許可リストを別に手書きしない（契約の二重管理を作らない）。
 * ⚠️ ディレクトリ宣言（末尾 `/`）だけはグロブにする。**静かに落とさない**——
 * 落とすと「宣言したのに書けない」が拒否ログにしか出ない形になる。
 */
export function editTargets(step: WorkflowStep): string[] {
  return [...(step.outputs ?? []), ...(step.optionalOutputs ?? [])].map((o) => o.path);
}

/**
 * `--tools` に渡す集合（設計 課題B の表）。
 *
 * 読み取り（Read / Grep / Glob）は無条件。書き込みは Edit のみ（**Write は渡さない**）。
 * Bash は**そのステップが許可コマンドを宣言しているときだけ**。
 * `Skill` / `Task` を含めないことで、pin CLI が隔離 home でも持っている組み込み skills を
 * 呼べなくする（設定の隔離だけでは消えないことを実測済み・§6）。
 */
export function toolSet(step: WorkflowStep): string {
  // 並びは設計文書 課題B の表と同じにしてある（読み比べたときに差が目に入るように）。
  const tools = ["Read", "Grep", "Glob"];
  if ((step.bashAllow ?? []).length > 0) {
    tools.push("Bash");
  }
  if (editTargets(step).length > 0) {
    tools.push("Edit");
  }
  return tools.join(",");
}

/**
 * `--allowedTools` に渡す許可ルール（1 要素 = 1 ルール）。
 *
 * `--permission-mode dontAsk` では未許可は問い合わせずに自動拒否され、
 * 拒否は `result.permission_denials` に残る（§5 / §9-2 実測）。
 */
export function allowRules(root: string, step: WorkflowStep): string[] {
  const rules = ["Read", "Grep", "Glob"];
  const base = longPath(path.resolve(root));
  for (const target of editTargets(step)) {
    const abs = toPosixAbsolute(path.join(base, target));
    rules.push(target.endsWith("/") ? `Edit(${abs.replace(/\/$/, "")}/**)` : `Edit(${abs})`);
  }
  for (const command of step.bashAllow ?? []) {
    rules.push(`Bash(${command})`);
  }
  return rules;
}

/**
 * 子プロセスの env を許可リストから組む。
 *
 * `DISABLE_AUTOUPDATER=1` を足す理由: pin した実体が自動更新で消えた実績があるため
 * （設計 A-3 の追記・2026-09-01 実測）。pin の意味を守る側の対策。
 */
export function claudeEnv(base: NodeJS.ProcessEnv, claudeHome: string): NodeJS.ProcessEnv {
  const allowed = new Set(CLAUDE_ENV_ALLOWLIST.map((n) => n.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && allowed.has(key.toLowerCase())) {
      env[key] = value;
    }
  }
  env.CLAUDE_CONFIG_DIR = claudeHome;
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

export type ClaudeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

/** `result.usage` を Event Log のトークン欄へ写す形にする。欠けた値は 0 に丸めず null。 */
export function usageFrom(event: any): ClaudeUsage | null {
  const u = event?.usage;
  if (!u || event?.type !== "result") {
    return null;
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    // ⚠️ claude の result には reasoning の内訳が無い。**0 で埋めない**
    // （「測れなかった」と「0 だった」を混ぜない）。
    reasoningTokens: null
  };
}

/**
 * `result.modelUsage` のキー = **実際に使われたモデル**（codex では取れなかった観測）。
 *
 * ⚠️ 実測では常に 2 つ（`claude-opus-5` + 補助の `claude-haiku-4-5-…`）だった。
 * 単一値のフィールドにしない（§9-4）。
 */
export function modelsObserved(event: any): string[] | null {
  const usage = event?.modelUsage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const keys = Object.keys(usage);
  return keys.length > 0 ? keys.sort() : null;
}

/** permission_denials を「件数 + ツール名」へ落とす。全文は runs/ の JSONL にある。 */
export function denialSummary(event: any): { count: number; tools: string[] } | null {
  const denials = event?.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) {
    return null;
  }
  const tools = [...new Set(denials.map((d: any) => String(d?.tool_name ?? "unknown")))].sort();
  return { count: denials.length, tools };
}

/**
 * stream-json のイベント1件を、表示用の行へ落とす。
 *
 * codex 版と違い**配列を返す**: assistant の1メッセージが text と tool_use を同時に運ぶし、
 * result は tokens と拒否を同時に運ぶ。無理に1行へ潰すと拒否が消える。
 *
 * ⚠️ 全文は載せない。⚠️ 生 session ID を含めない（防衛線2）。
 */
export function summarize(event: any, secret: SessionSecret | null): ExecutorProgress[] {
  const type = event?.type;
  if (type === "assistant") {
    const out: ExecutorProgress[] = [];
    const content = event.message?.content;
    if (typeof event.error === "string" || event.is_api_error_message === true) {
      const text = textOf(content) || String(event.error ?? "api error");
      return [{ kind: "error", text: `error: ${truncate(redactSession(text, secret), 200)}` }];
    }
    for (const block of Array.isArray(content) ? content : []) {
      switch (block?.type) {
        case "text":
          out.push({ kind: "message", text: flatten(block.text, 240) });
          break;
        case "thinking":
          out.push({ kind: "thinking", text: "thinking..." });
          break;
        case "tool_use":
          out.push(toolLine(block));
          break;
        default:
          break;
      }
    }
    return out;
  }
  if (type === "result") {
    const out: ExecutorProgress[] = [];
    const denials = denialSummary(event);
    if (denials) {
      // ⚠️ 拒否は**既定の表示でも出す**。黙って諦めて exit 0 になる形を人間から隠さない。
      for (const tool of denials.tools) {
        out.push({ kind: "error", text: `denied: ${tool}` });
      }
    }
    if (event.is_error === true) {
      out.push({ kind: "error", text: `error: ${truncate(redactSession(String(event.result ?? ""), secret), 200)}` });
    }
    const u = event.usage ?? {};
    out.push({
      kind: "tokens",
      text: `tokens: in ${k(u.input_tokens)} / out ${k(u.output_tokens)} / cacheRead ${k(u.cache_read_input_tokens)}`
    });
    return out;
  }
  return [];
}

/**
 * assistant イベントから **Read した対象のファイル名**を拾う（M4 段階1-3）。
 *
 * ## なぜ記録するか
 *
 * 知識ファイルは「全文結合」から「目次 + 必要な節を読む」へ移す。
 * ⚠️ **ポインタ方式は実測で 5 周中 4 周（= 1/5 の不発）**——「読め」と書いてあっても読まれない回がある。
 * 目次に条件付き必読を書いたうえで、**読んだ形跡を残す**のが最後の観測点になる。
 *
 * ⚠️ **判定には使わない。** ok / failureKind / 遷移は一切変えない。
 * 「条件に当たるのに読んでいない」を**事後に人間が見つけられる**ようにするためだけの記録。
 * 自動で咎めると、読まずに正解できた回まで止めることになる（検出と判定を混ぜない）。
 *
 * basename だけを残すのは Event Log を短く保つため（全文は runs/ の JSONL にある）。
 */
export function readTargets(event: any): string[] {
  if (event?.type !== "assistant") {
    return [];
  }
  const content = event.message?.content;
  const out: string[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== "tool_use" || block?.name !== "Read") {
      continue;
    }
    const file = String(block.input?.file_path ?? "");
    if (file !== "") {
      out.push(path.basename(file));
    }
  }
  return out;
}

function toolLine(block: any): ExecutorProgress {
  const name = String(block?.name ?? "tool");
  const input = block?.input ?? {};
  if (name === "Bash") {
    return { kind: "shell", text: `shell: ${firstLine(input.command)}` };
  }
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    return { kind: "edit", text: `edit: ${file ? path.basename(file) : "(no path)"}` };
  }
  return { kind: "thinking", text: `tool: ${name}` };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join(" ");
}

function firstLine(value: unknown): string {
  const s = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  return s.split("\n")[0].trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** 複数行の本文を1行へ畳む（改行と連続空白を1つの空白にする）。 */
function flatten(value: unknown, n: number): string {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim(), n);
}

function k(n: unknown): string {
  return typeof n === "number" ? (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)) : "?";
}

/**
 * 失敗の分類（設計 課題F）。
 *
 * ⚠️ **入力は観測されたイベントと終了コード。成功判定には使わない。**
 * 再試行に意味があるか（transient）／人間の手当が要るか（permanent）だけを決める。
 */
export function classifyFailure(input: {
  apiErrorStatus?: unknown;
  subtype?: unknown;
  text: string;
}): "transient" | "permanent" {
  const status = typeof input.apiErrorStatus === "number" ? input.apiErrorStatus : null;
  if (status === 401 || status === 403) {
    return "permanent";
  }
  if (status === 429 || (status !== null && status >= 500)) {
    return "transient";
  }
  if (input.subtype === "error_max_turns" || input.subtype === "error_max_budget_usd") {
    return "permanent";
  }
  if (/not logged in|authentication_failed|unauthorized|invalid api key|refus/i.test(input.text)) {
    return "permanent";
  }
  if (/rate.?limit|overloaded|429|50\d\b|timeout|econnreset|etimedout/i.test(input.text)) {
    return "transient";
  }
  // 分からないものは transient に倒す（再試行の余地を残す）。permanent は「再試行しても
  // 同じ」と言い切れるときだけ——言い切れない失敗を人間送りにすると無人運転が止まる。
  return "transient";
}

export function createClaudeExecutor(deps: ClaudeDeps = {}): StepExecutor {
  const now = deps.now ?? (() => Date.now());

  return {
    name: "claude" as ExecutorName,
    async execute(req: ExecutorRequest): Promise<ExecutorResult> {
      const paths = rootPaths(req.root);
      // ⚠️ 通常は engine（watchdog）が解決した値が来る。executor は独自タイマーを持たない。
      const timeoutMs = req.timeoutMs ?? numberSetting(req.config.settings.claudeTimeoutMs) ?? CLAUDE_DEFAULT_TIMEOUT_MS;

      // --- 実行体（pin）。自動更新で消えた実績があるので、起動前に実在を確かめる ---
      const entry = claudeEntrypoint();
      if (!existsSync(entry)) {
        const stale = findStaleBinaries(entry);
        const hint =
          stale.length > 0
            ? `自動更新が実体を改名した可能性があります（${stale.join(", ")}）。元の名前へ戻してください。`
            : `pin した @anthropic-ai/claude-code を再インストールしてください。`;
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error: `claude executor: 実行体が見つかりません（${entry}）。${hint}`,
          meta: { executor: "claude", stage: "entrypoint", entry, stale }
        };
      }

      // --- 作業ディレクトリ。diff-scope と同じ解決を使う（検査範囲と実行範囲を揃える） ---
      let projectRoot = req.projectRoot;
      if (!projectRoot) {
        const resolved = resolveCheckRepoRoot(req.root, req.config);
        if (!resolved.ok) {
          return {
            ok: false,
            outputs: [],
            failureKind: "permanent",
            error: `claude executor: 実行対象のリポジトリを特定できません（${resolved.reason}）。settings.repoRoot を確認してください。`,
            meta: { executor: "claude", stage: "resolve-repo-root" }
          };
        }
        projectRoot = resolved.repoRoot;
      }

      // runtimeRoot が cwd の外にあると成果物を書けない。黙って書けない状態で走らせない。
      // ⚠️ **両辺を正式表記へ直してから比べる。** repoRoot は git が返す長い名前、
      // runtimeRoot は呼び出し側が渡した表記（短縮名のことがある）なので、
      // 生の文字列で比べると「中にあるのに外」と誤判定する（2026-09-04 のスモークで実測）。
      const addDir = isInside(longPath(paths.root), longPath(projectRoot)) ? null : paths.root;

      // --- 隔離 CLAUDE_CONFIG_DIR ---
      const claudeHome = resolveClaudeHome(req.root, stringSetting(req.config.settings.claudeHome));
      if (!existsSync(claudeHome)) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error:
            `claude executor: 隔離 CLAUDE_CONFIG_DIR が見つかりません（${claudeHome}）。` +
            `ディレクトリを作成し、そこで一度だけ claude auth login を実行してください（人間が実施）。`,
          meta: { executor: "claude", stage: "claude-home" }
        };
      }

      // --- プロンプト（組み立て済みのものをそのまま渡す。executor は何も足さない） ---
      const assembly = assembleStepPrompt(req.root, req.step.id, req.step);
      if (assembly.parts.length === 0) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error: `claude executor: ステップ "${req.step.id}" に配るプロンプトがありません。`,
          meta: { executor: "claude", stage: "assemble" }
        };
      }

      const runDir = path.join(paths.runsDir, "claude");
      mkdirSync(runDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const jsonlPath = path.join(runDir, `${stamp}-${req.step.id}.jsonl`);

      const model = stringSetting(req.step.model) ?? stringSetting(req.config.settings.claudeModel);
      const effort = stringSetting(req.step.effort) ?? stringSetting(req.config.settings.claudeEffort);
      const tools = toolSet(req.step);
      const allowed = allowRules(req.root, req.step);

      const argv = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        // ⚠️ 空文字が「どの設定ソースも読まない」の指定。プロジェクト CLAUDE.md の遮断手段。
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        ...(addDir ? ["--add-dir", addDir] : []),
        // ⚠️ 可変長オプションは末尾に置く（後続の引数を飲み込むため）。
        "--tools",
        tools,
        "--allowedTools",
        ...allowed
      ];

      const launch = deps.launch ?? defaultLaunch(entry);
      const startedAt = now();
      let secret: SessionSecret | null = null;
      let sessionRef: SessionRef | null = null;
      let usage: ClaudeUsage | null = null;
      let modelObserved: string[] | null = null;
      let toolsObserved: string[] | null = null;
      const filesRead = new Set<string>();
      let denials: { count: number; tools: string[] } | null = null;
      let resultIsError: boolean | null = null;
      let apiErrorStatus: unknown = null;
      let resultSubtype: unknown = null;
      let errorCount = 0;
      let firstError: string | null = null;

      const child = launch(argv, {
        cwd: projectRoot,
        env: claudeEnv(process.env, claudeHome)
      });

      const sink = createWriteStream(jsonlPath, { flags: "a" });
      const emit = (event: ExecutorProgress) => {
        try {
          req.onProgress?.(event);
        } catch {
          // 表示の失敗で実行を落とさない
        }
      };

      const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>(
        (resolve) => {
          child.on("error", (err) => resolve({ code: null, signal: null, spawnError: err }));
          child.on("close", (code, signal) => resolve({ code, signal }));
        }
      );

      // 中断は watchdog（総上限・無進行）と外部シグナルの両方から来る。**ここでタイマーは持たない。**
      let abortedFlag = false;
      const onAbort = () => {
        abortedFlag = true;
        child.kill("SIGTERM");
      };
      if (req.signal?.aborted) {
        onAbort();
      } else {
        req.signal?.addEventListener("abort", onAbort, { once: true });
      }

      // JSONL を1行ずつ: 保存（生のまま） + 要約を通知
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          if (line.trim() === "") {
            return;
          }
          sink.write(`${line}\n`);
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return; // JSON でない出力は保存だけして表示しない
          }
          // ⚠️ 生 session ID は init だけでなく**全メッセージ**に載っている（§3 観測6）。
          // 最初に見た値を secret として捕まえ、以後は redact の材料にする。
          if (secret === null && typeof event.session_id === "string" && event.session_id !== "") {
            secret = sessionSecret(event.session_id);
            sessionRef = toSessionRef(secret);
          }
          if (event.type === "system" && event.subtype === "init" && Array.isArray(event.tools)) {
            // 「どの制限で走っているか」を起動直後に記録する（§3 観測1）
            toolsObserved = event.tools.map((t: unknown) => String(t)).sort();
          }
          for (const name of readTargets(event)) {
            filesRead.add(name);
          }
          if (event.type === "result") {
            usage = usageFrom(event) ?? usage;
            modelObserved = modelsObserved(event) ?? modelObserved;
            denials = denialSummary(event) ?? denials;
            resultIsError = event.is_error === true;
            apiErrorStatus = event.api_error_status ?? null;
            resultSubtype = event.subtype ?? null;
            if (event.is_error === true) {
              firstError ??= redactSession(String(event.result ?? ""), secret);
            }
          }
          const lines = summarize(event, secret);
          for (const progress of lines) {
            if (progress.kind === "error") {
              errorCount += 1;
              firstError ??= progress.text;
            }
            emit(progress);
          }
        });
      }

      let stderrTail = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000);
        });
      }

      // プロンプトは stdin（argv 長の上限に依存しない・§4）
      if (child.stdin) {
        child.stdin.end(assembly.text);
      }

      const outcome = await finished;
      req.signal?.removeEventListener("abort", onAbort);
      // ⚠️ flush を待ってから返す。待たないと JSONL の末尾が落ちる。
      await new Promise<void>((resolve) => sink.end(resolve));

      const durationMs = now() - startedAt;
      // KI-08 の二重判定。内部フラグだけを信じず、signal と実測時間からも裏を取る。
      const interrupted = abortedFlag || outcome.signal !== null || durationMs >= timeoutMs;

      const meta: Record<string, unknown> = {
        executor: "claude",
        // 指定値（未指定は "unspecified"。「未指定と記録した」と「記録が無い」を区別する）
        modelRequested: model ?? "unspecified",
        // ⚠️ **実測値**。codex では取れなかった観測（複数キーになりうる・§9-4）
        modelObserved,
        // ⚠️ effort は observed が取れない（出力のどこにも残らない・§8 実測）。
        // 名前で「指定値である」ことを明示する。silent downgrade がありうる。
        effortRequested: effort ?? "unspecified",
        exitCode: outcome.code,
        durationMs,
        jsonl: path.relative(paths.root, jsonlPath).replace(/\\/g, "/"),
        session: sessionRef, // ⚠️ hash と末尾のみ。生 ID は載せない
        usage,
        checkRepoRoot: projectRoot,
        addDir,
        tools,
        toolsObserved,
        editAllowed: editTargets(req.step),
        // ⚠️ **観測であって判定ではない。** 知識ファイルを「目次 + 必要な節を読む」へ移した以上、
        // 読み漏れは記録からしか分からない（ポインタ方式は実測 1/5 の不発）。
        filesRead: [...filesRead].sort(),
        // ⚠️ 拒否を黙らせない。件数とツール名を残す（全文は runs/ の JSONL）
        permissionDenials: denials,
        errorEvents: errorCount,
        // 送った本文の指紋。組み立て出力と一致することを故障注入 #6 で照合する
        promptSha256: createHash("sha256").update(assembly.text).digest("hex")
      };

      if (outcome.spawnError) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error: `claude executor: 起動できません（${outcome.spawnError.message}）。pin した @anthropic-ai/claude-code が壊れている可能性があります。`,
          meta
        };
      }
      if (interrupted) {
        return {
          ok: false,
          outputs: [],
          failureKind: "transient",
          error: `claude executor: ${Math.round(durationMs / 1000)}s で中断されました（上限 ${Math.round(timeoutMs / 1000)}s）。`,
          meta: { ...meta, timedOut: true }
        };
      }
      // ⚠️ 成否の正は `is_error`。**`subtype` は認証失敗でも "success" を返す**（§3 観測5）。
      if (resultIsError === true || outcome.code !== 0) {
        const text = `${firstError ?? ""} ${stderrTail}`;
        return {
          ok: false,
          outputs: [],
          failureKind: classifyFailure({ apiErrorStatus, subtype: resultSubtype, text }),
          error: `claude executor: 失敗しました（exit ${outcome.code}）。${truncate(firstError ?? firstLine(stderrTail), 200)}`,
          meta
        };
      }

      // ⚠️ exit 0 / is_error:false は「作業をした」を意味しない
      // （実測: permission 拒否でも正常終了する・§9-2）。成果物の有無は validator が決める。
      return { ok: true, outputs: [], meta };
    }
  };
}

function defaultLaunch(entry: string) {
  return (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ClaudeProcess =>
    spawn(entry, argv, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false, // KI-08
      stdio: ["pipe", "pipe", "pipe"]
    }) as unknown as ClaudeProcess;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stringSetting(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function numberSetting(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export const claudeExecutor: StepExecutor = createClaudeExecutor();
