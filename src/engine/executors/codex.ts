// codex executor（M3 段階1）。設計は docs/design-codex-executor.md が正本。
//
// 契約(types.ts)のうち、この executor で特に効くもの:
//   - state.json を触らない。validator を呼ばない。遷移を判定しない
//   - **成果物を検証しない**。current-result.md / current-status.json は Codex がファイルへ書き、
//     当否は `aiw run` の validator が決める
//
// 実測に基づく設計判断（詳細は設計文書の「調査結果」）:
//   - プロンプトは **stdin** で渡す。argv は今日なら通る（最大 11,724 / 上限 32,481 文字）が、
//     超えたときの失敗が OS レベルで遅く不明瞭になる。プロンプトの成長が機能に影響しない形にする
//   - **shell を経由しない**（KI-08: shell:true だとタイムアウトが exit 1 に化けて本物の失敗と
//     見分けがつかない）
//   - **exit code を成功判定に使わない**。read-only サンドボックスが書き込みを拒否しても
//     exit 0 で返ることを実測済み
//   - CODEX_HOME を隔離する。共有するとアプリの config.toml が実行のたびに汚れる（実測）
//   - **タイマーを持たない**（2026-09-17・BL-221 で claude.ts に揃えた）。総上限と無進行の見張りは
//     engine/watchdog.ts が担い、ここは `req.signal` を配線するだけ。本番で codex executor を呼ぶ経路は
//     engine の execStep だけで、必ず watchdog の signal と `req.timeoutMs` が渡る（撤去前に grep で確認）。
//     ⚠️ execStep を通さずに直接呼ぶなら、止めたい側が signal を渡すこと
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { assembleStepPrompt } from "../promptAssembly.js";
import { rootPaths } from "../paths.js";
import { resolveCheckRepoRoot } from "../gitScope.js";
import { redactSession, sessionSecret, toSessionRef, type SessionRef, type SessionSecret } from "../session.js";
import type { ExecutorName } from "../types.js";
import { DEFAULT_TOTAL_TIMEOUT_MS } from "../watchdog.js";
import type { ExecutorProgress, ExecutorRequest, ExecutorResult, StepExecutor } from "./types.js";

// `CODEX_DEFAULT_TIMEOUT_MS`（30 分）と自前の setTimeout は 2026-09-17 に撤去した（BL-221 (3)）。
// エンジン経由では必ず req.timeoutMs が埋まるので、2026-09-02 の時点で「死んでいると証明された既定」だった。
// ここで使う上限は KI-08 の二重判定（実測時間 ≥ 上限か）と表示のためだけの値。

export type CodexDeps = {
  /** テスト用の差し替え口。既定は pin した @openai/codex の JS シムを node で起動する */
  launch?: (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => CodexProcess;
  now?: () => number;
};

export type CodexProcess = {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): void;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

/**
 * pin した codex の起動引数を組み立てる。
 *
 * `node_modules/.bin/codex` は Windows では `.cmd` で、shell 無しでは起動できない。
 * パッケージの JS シム（`bin/codex.js`）を node で直接叩くことで shell を避ける。
 * シムは `stdio: "inherit"` で実体を spawn するので、こちらのパイプはそのまま透過する。
 */
export function codexEntrypoint(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.resolve(here, "..", "..", "..", "node_modules", "@openai", "codex", "bin", "codex.js");
}

/**
 * 子プロセスへ渡す env の**許可リスト**（BL-220・2026-09-17。claude.ts の CLAUDE_ENV_ALLOWLIST と同じ方式）。
 *
 * ⚠️ **拒否リストにしない。** codex 0.147.0 の実体は、隔離 CODEX_HOME の外から認証や接続先を差し込める変数を読む
 * （バイナリから実測: `OPENAI_API_KEY` / `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` / `CODEX_REFRESH_TOKEN` /
 * `CODEX_AUTHAPI_BASE_URL` / `CODEX_URL` / `CODEX_EXEC_SERVER_URL` / `OPENAI_ORGANIZATION` …）。名前は版ごとに増えるので、
 * 「OPENAI_* と CODEX_* を除く」では将来の変数を塞げない。渡すものを列挙し、それ以外は落とす。
 * 実測: 以前は `{ ...process.env }` で、aiw が Claude Code の配下で動くと `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_*` を含む
 * 25 個の無関係な変数も codex へ渡っていた。
 *
 * **実害の実測（2026-09-17・codex exec を実際に起動）**: 全継承のまま親に `CODEX_API_KEY` を置くと、隔離 CODEX_HOME の
 * ChatGPT ログインが**上書きされて** 401 で失敗した（偽の値だったので失敗で済んだ。本物なら黙って別の資格情報で走る）。
 * 許可リストでは同じ親の環境から認証が通り、成果物が書かれ、偽の 3 変数は子へ渡らなかった（27 秒）。
 *
 * 出発点は CLAUDE_ENV_ALLOWLIST（**共通化はしない**・M4.4）で、codex 固有の追加は無い。
 * ⚠️ **起動できる最小は `PATH` + `SystemRoot`（+ CODEX_HOME）だった**（同じ実測。ファイル 1 つを書く課題で認証・書き込みとも成功）。
 * それでもこのリストを削らないのは、implementation / fix の codex が npm / dotnet / git / Playwright を子として動かすため——
 * それらの `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `TEMP` の要否は、ファイル 1 つのプローブでは測れない。
 * このリストは review（claude）が dotnet build / nrun / curl を実際に回している組み合わせで、実働の根拠がある。
 * ⚠️ プロキシ（`HTTPS_PROXY` 等）と CA 証明書（`SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE`）は**入れていない**。
 * 今の環境には無く、必要な環境では接続エラーとして**大きな声で**失敗する（黙って別の経路へ流れはしない）ので、
 * そのときに実測して足す。
 *
 * 照合は**大文字小文字を無視**する（Windows の env 名は大小混在で入っている）。
 */
export const CODEX_ENV_ALLOWLIST = [
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

/** 子プロセスの env を許可リストから組み、隔離 CODEX_HOME を足す。 */
export function codexEnv(base: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const allowed = new Set(CODEX_ENV_ALLOWLIST.map((n) => n.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && allowed.has(key.toLowerCase())) {
      env[key] = value;
    }
  }
  env.CODEX_HOME = codexHome;
  return env;
}

/** 隔離 CODEX_HOME の絶対パス。既定は runtimeRoot 配下の `.codex-home`。 */
export function resolveCodexHome(root: string, declared?: string): string {
  const value = declared && declared.trim() !== "" ? declared : ".codex-home";
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/** codex の JSONL イベント1件を、表示用の1行サマリへ落とす。全文は載せない。 */
export function summarize(event: any, secret: SessionSecret | null): ExecutorProgress | null {
  const type = event?.type;
  if (type === "item.started" || type === "item.completed") {
    const item = event.item ?? {};
    const done = type === "item.completed";
    switch (item.type) {
      case "file_change": {
        const paths = (item.changes ?? []).map((c: any) => c?.path).filter(Boolean);
        if (!done) {
          return null; // 開始と完了で二重に出さない
        }
        return { kind: "edit", text: `edit: ${paths.map((p: string) => path.basename(p)).join(", ") || "(no path)"}` };
      }
      case "command_execution": {
        if (!done) {
          return { kind: "shell", text: `shell: ${firstLine(item.command)}` };
        }
        const status = item.exit_code === undefined ? "" : ` → exit ${item.exit_code}`;
        return { kind: "shell", text: `shell: ${firstLine(item.command)}${status}` };
      }
      case "reasoning":
        return done ? null : { kind: "thinking", text: "thinking..." };
      case "agent_message":
        // 画面に出る既定はこの種類だけなので、1行目 80 文字では削りすぎる。
        // 改行を潰して 1 行に畳んだうえで、読める長さまで見せる。全文は runs/ の JSONL にある。
        return done ? { kind: "message", text: flatten(item.text, 240) } : null;
      default:
        return done ? { kind: "message", text: `${item.type ?? "item"}` } : null;
    }
  }
  if (type === "turn.completed") {
    const u = event.usage ?? {};
    return { kind: "tokens", text: `tokens: in ${k(u.input_tokens)} / out ${k(u.output_tokens)}` };
  }
  if (type === "error") {
    return { kind: "error", text: `error: ${truncate(redactSession(String(event.message ?? ""), secret), 120)}` };
  }
  return null;
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

export type CodexUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

/** ⚠️ codex の `input_tokens` は**キャッシュ込み**（`cached_input_tokens` を含む）。claude の inputTokens とは意味が違うので
 *  executor をまたいで合算・比較しない（定義は eventLog.ts の appendEvent のコメント・2026-09-17 実測）。 */
export function usageFrom(event: any): CodexUsage | null {
  const u = event?.usage;
  if (!u) {
    return null;
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cached_input_tokens),
    cacheWriteTokens: num(u.cache_write_input_tokens),
    reasoningTokens: num(u.reasoning_output_tokens)
  };
}

export function createCodexExecutor(deps: CodexDeps = {}): StepExecutor {
  const now = deps.now ?? (() => Date.now());

  return {
    name: "codex" as ExecutorName,
    async execute(req: ExecutorRequest): Promise<ExecutorResult> {
      const paths = rootPaths(req.root);
      const timeoutMs = req.timeoutMs ?? numberSetting(req.config.settings.executorTimeoutMs) ?? DEFAULT_TOTAL_TIMEOUT_MS;

      // --- 起動前に中断済みなら起動しない（BL-221 (4)） ---
      // ⚠️ abort 済みの AbortSignal に listener を足しても abort イベントは二度と来ない。
      // 以前は listener を足すだけだったので、watchdog が起動前に abort した場合（externalSignal が既に
      // aborted の分岐）でも codex が最後まで走っていた。M5 の停止はここに依存する。
      if (req.signal?.aborted) {
        return {
          ok: false,
          outputs: [],
          failureKind: "transient",
          error: "codex executor: 起動前に中断されました（プロセスは起動していない）。",
          meta: { executor: "codex", stage: "aborted-before-launch", launched: false, timedOut: true }
        };
      }

      // --- 作業ディレクトリ（-C）。diff-scope と同じ解決を使う（検査範囲と実行範囲を揃える） ---
      let projectRoot = req.projectRoot;
      if (!projectRoot) {
        const resolved = resolveCheckRepoRoot(req.root, req.config);
        if (!resolved.ok) {
          return {
            ok: false,
            outputs: [],
            failureKind: "permanent",
            error: `codex executor: 実行対象のリポジトリを特定できません（${resolved.reason}）。settings.repoRoot を確認してください。`,
            meta: { executor: "codex", stage: "resolve-repo-root" }
          };
        }
        projectRoot = resolved.repoRoot;
      }

      // runtimeRoot が workspace の外にあると、Codex は成果物を書けない。
      // 黙って書けない状態で走らせない（設計 A-2）。
      // ⚠️ **両辺を正式表記へ直してから比べる**（BL-221 (1)・claude.ts と同じ）。repoRoot は git が返す長い名前、
      // runtimeRoot は呼び出し側の表記（8.3 短縮名のことがある）なので、生の文字列では「中にあるのに外」になる。
      const addDir = isInside(longPath(paths.root), longPath(projectRoot)) ? null : paths.root;

      // --- 隔離 CODEX_HOME ---
      const codexHome = resolveCodexHome(req.root, stringSetting(req.config.settings.codexHome));
      if (!existsSync(codexHome)) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error:
            `codex executor: 隔離 CODEX_HOME が見つかりません（${codexHome}）。` +
            `ディレクトリを作成し、そこで一度だけ codex login を実行してください（人間が実施）。`,
          meta: { executor: "codex", stage: "codex-home" }
        };
      }

      // --- プロンプト（組み立て済みのものをそのまま渡す。executor は何も足さない） ---
      const assembly = assembleStepPrompt(req.root, req.step.id, req.step);
      if (assembly.parts.length === 0) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error: `codex executor: ステップ "${req.step.id}" に配るプロンプトがありません。`,
          meta: { executor: "codex", stage: "assemble" }
        };
      }

      const runDir = path.join(paths.runsDir, "codex");
      mkdirSync(runDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const jsonlPath = path.join(runDir, `${stamp}-${req.step.id}.jsonl`);
      const lastMessagePath = path.join(runDir, `${stamp}-${req.step.id}.last-message.txt`);

      // モデルの pin。未指定なら `-m` を渡さず codex の既定に委ねる。
      // ⚠️ 委ねた場合、**実際に使われたモデルはどこにも残らない**（JSONL にモデル名は無く、
      // codex doctor も `<default>` としか言わない）。だから記録は「指定値」であり、
      // 実測値ではない。フィールド名を modelRequested にしてその区別を型で持たせる。
      const model = stringSetting(req.config.settings.codexModel);

      const argv = [
        codexEntrypoint(),
        "exec",
        ...(model ? ["-m", model] : []),
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--strict-config",
        // ⚠️ `-s/--sandbox` と `--approve-for-me` は **排他**（0.147.0 実測。併記すると exit 2）。
        // --approve-for-me は「workspace-write サンドボックスを使って承認要求を自動レビューへ回す」
        // フラグなので、これ単体で「ワークスペース内は書ける + 無人で止まらない」を満たす。
        // 設計(課題A-4)は両方を併記していたが、実装時に排他と判明したためこちらを採る。
        "--approve-for-me",
        "-C",
        projectRoot,
        "-o",
        lastMessagePath,
        ...(addDir ? ["--add-dir", addDir] : []),
        "-"
      ];

      const launch = deps.launch ?? defaultLaunch;
      const startedAt = now();
      let secret: SessionSecret | null = null;
      let sessionRef: SessionRef | null = null;
      let usage: CodexUsage | null = null;
      let errorCount = 0;
      let firstError: string | null = null;
      const itemCounts: Record<string, number> = {};

      const child = launch(argv, {
        cwd: projectRoot,
        env: codexEnv(process.env, codexHome) // BL-220: 許可リスト方式（全継承にしない）
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
        onAbort(); // claude.ts と同じ形の保険（起動前チェックからここまでは同期区間なので通常は到達しない）
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
          if (event?.type === "thread.started" && typeof event.thread_id === "string") {
            secret = sessionSecret(event.thread_id);
            sessionRef = toSessionRef(secret);
            return; // ⚠️ 生 ID は表示しない
          }
          if (event?.type === "item.completed" || event?.type === "item.started") {
            const t = event.item?.type ?? "unknown";
            if (event.type === "item.completed") {
              itemCounts[t] = (itemCounts[t] ?? 0) + 1;
            }
          }
          if (event?.type === "error") {
            errorCount += 1;
            firstError ??= redactSession(String(event.message ?? ""), secret);
          }
          const u = usageFrom(event);
          if (u) {
            usage = u;
          }
          const progress = summarize(event, secret);
          if (progress) {
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

      // プロンプトは stdin（argv 長の上限に依存しない）
      if (child.stdin) {
        child.stdin.end(assembly.text);
      }

      const outcome = await finished;
      req.signal?.removeEventListener("abort", onAbort);
      // ⚠️ flush を待ってから返す。待たないと JSONL の末尾が落ち、
      // 直後に落ちた場合や aiw log が読む場合に途中までのファイルを掴む。
      await new Promise<void>((resolve) => sink.end(resolve));

      const durationMs = now() - startedAt;
      // KI-08 の二重判定。内部フラグだけを信じず、signal と実測時間からも裏を取る。
      const timedOut = abortedFlag || outcome.signal !== null || durationMs >= timeoutMs;

      const meta: Record<string, unknown> = {
        executor: "codex",
        // ⚠️ **指定値であって実測値ではない。** codex は使ったモデルをイベントにもログにも残さない
        // （実タスク 70 イベントを走査して "model" の出現 0 件・2026-08-19 実測）。
        // 未指定を null や欠落にしないのは、「未指定と記録した」と「記録が無い」を
        // 区別するため（三値の規律と同じ）。
        modelRequested: model ?? "unspecified",
        exitCode: outcome.code,
        durationMs,
        jsonl: path.relative(paths.root, jsonlPath).replace(/\\/g, "/"),
        lastMessage: path.relative(paths.root, lastMessagePath).replace(/\\/g, "/"),
        items: itemCounts,
        errorEvents: errorCount,
        session: sessionRef, // ⚠️ hash と末尾のみ。生 ID は載せない
        usage,
        checkRepoRoot: projectRoot,
        addDir
      };

      if (outcome.spawnError) {
        return {
          ok: false,
          outputs: [],
          failureKind: "permanent",
          error: `codex executor: 起動できません（${outcome.spawnError.message}）。pin した @openai/codex が壊れている可能性があります。`,
          meta
        };
      }
      if (timedOut) {
        return {
          ok: false,
          outputs: [],
          failureKind: "transient",
          // claude.ts と同じ文言。総上限・無進行・外部中断のどれかは executor には分からない（種別はエンジンが書き足す）
          error: `codex executor: ${Math.round(durationMs / 1000)}s で中断されました（上限 ${Math.round(timeoutMs / 1000)}s）。`,
          meta: { ...meta, timedOut: true }
        };
      }
      if (outcome.code !== 0) {
        // 分類は exit code ではなく、観測されたイベントから導く（設計 C-1）。
        const text = `${firstError ?? ""} ${stderrTail}`;
        const permanent = /401|unauthorized|not authenticated|invalid api key/i.test(text);
        return {
          ok: false,
          outputs: [],
          failureKind: permanent ? "permanent" : "transient",
          error: `codex executor: 異常終了しました（exit ${outcome.code}）。${truncate(firstError ?? firstLine(stderrTail), 200)}`,
          meta
        };
      }

      // ⚠️ exit 0 は「作業をした」を意味しない（実測: read-only 拒否でも 0）。
      // 成果物の有無は validator が決める。ここでは「プロセスが完走した」だけを返す。
      return { ok: true, outputs: [], meta };
    }
  };
}

function defaultLaunch(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): CodexProcess {
  return spawn(process.execPath, argv, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false, // KI-08
    stdio: ["pipe", "pipe", "pipe"]
  }) as unknown as CodexProcess;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** OS の正式表記へ直す（8.3 短縮名・シンボリックリンクを畳む）。claude.ts と同じ。実在しないパスはそのまま返す。 */
function longPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

// BL-221 (2): claude.ts / engine と同じ強さ。以前は空文字・NaN・0・負数を通していた
// （空文字の codexHome は既定へ落ちず root そのものを指し、0 の上限は即中断になる）。
function stringSetting(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function numberSetting(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export const codexExecutor: StepExecutor = createCodexExecutor();
