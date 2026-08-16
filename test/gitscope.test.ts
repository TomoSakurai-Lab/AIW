import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureIfAbsent,
  compareToBaseline,
  parsePorcelainZ,
  readBaseline,
  readRepoState,
  recaptureBaseline,
  resolveCheckRepoRoot,
  type Baseline
} from "../src/engine/gitScope.js";
import { isDeclared, parseDeclaredFiles, parseDeclaredLine } from "../src/engine/declaredFiles.js";
import { makeRoot } from "./helpers.js";

// ---- 一時 git リポジトリ ----

function makeGitRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "aiw-git-"));
  const g = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", ".");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  return repo;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function write(repo: string, rel: string, body: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
}

/** baseline を関数として作る（capture のファイル IO を経由しない純粋な比較テスト用） */
function baselineFrom(repo: string, step = "implementation", fixAttempts = 0): Baseline {
  const s = readRepoState(repo);
  return {
    version: 1,
    capturedFor: { step, fixAttempts },
    capturedAt: new Date().toISOString(),
    checkRepoRoot: repo,
    headSha: s.headSha,
    ignoreCase: s.ignoreCase,
    dirty: s.dirty
  };
}

// ---------------------------------------------------------------------------
// porcelain -z のパース
// ---------------------------------------------------------------------------

// Test 42 — -z 形式。既定の porcelain は空白入りパスを引用するため -z を使う。
// rename は `R  <新>NUL<旧>NUL` で、非-z の `旧 -> 新` とは順序が逆。
test("42: parsePorcelainZ handles renames, deletes and spaces", () => {
  const raw = " M b.txt\0R  renamed.txt\0a.txt\0 D sub/c.txt\0?? with space.txt\0";
  const entries = parsePorcelainZ(raw);

  assert.deepEqual(
    entries.map((e) => e.path),
    ["b.txt", "renamed.txt", "sub/c.txt", "with space.txt"]
  );
  assert.equal(entries[1].origPath, "a.txt", "rename keeps the source path");
  assert.equal(entries[1].state, "R ");
  assert.equal(entries[3].path, "with space.txt", "-z never quotes");
});

// Test 43 — 実リポジトリでの状態読み取り。空リポジトリ（初回コミット前）で headSha が null。
test("43: readRepoState reports null headSha on an empty repo", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "a\n");

  const state = readRepoState(repo);
  assert.equal(state.headSha, null, "初回コミット前は HEAD が無い");
  assert.equal(typeof state.ignoreCase, "boolean");
  assert.deepEqual(state.dirty.map((d) => d.path), ["a.txt"]);
  assert.ok(state.dirty[0].sha256, "untracked でも内容ハッシュを取る");

  commitAll(repo, "init");
  assert.ok(readRepoState(repo).headSha, "コミット後は HEAD が取れる");
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compareToBaseline — シナリオ1〜8の判定そのもの
// ---------------------------------------------------------------------------

// Test 44 — シナリオ1: 開始前から無関係な dirty が多数あっても違反にしない。
test("44: pre-existing dirty files are not changes (scenario 1)", () => {
  const repo = makeGitRepo();
  write(repo, "tracked.txt", "v1\n");
  commitAll(repo, "init");

  // タスク開始前から dirty
  write(repo, "tracked.txt", "edited by human\n");
  write(repo, "untracked-a.txt", "wip\n");
  write(repo, "untracked-b.txt", "wip\n");

  const baseline = baselineFrom(repo);
  assert.equal(baseline.dirty.length, 3);

  const cmp = compareToBaseline(baseline, readRepoState(repo));
  assert.deepEqual(cmp.changed, [], "何もしていなければ変更ゼロ");
  assert.equal(cmp.headMoved, null);
  rmSync(repo, { recursive: true, force: true });
});

// Test 45 — シナリオ2/3/7: 新規作成・既存編集・既 dirty の追加編集を区別する。
test("45: new-dirty and modified-since are distinguished (scenarios 2/3/7)", () => {
  const repo = makeGitRepo();
  write(repo, "declared.txt", "v1\n");
  write(repo, "other.txt", "v1\n");
  write(repo, "already-dirty.txt", "v1\n");
  commitAll(repo, "init");
  write(repo, "already-dirty.txt", "human edit\n"); // 開始前から dirty

  const baseline = baselineFrom(repo);

  // タスク中の変更
  write(repo, "created.txt", "codex made this\n"); // シナリオ2: 新規作成
  write(repo, "other.txt", "codex edited this\n"); // シナリオ3: 既存編集
  write(repo, "already-dirty.txt", "human edit + codex\n"); // シナリオ7: 追加編集

  const cmp = compareToBaseline(baseline, readRepoState(repo));
  const byPath = new Map(cmp.changed.map((c) => [c.path, c.kind]));

  assert.equal(byPath.get("created.txt"), "new-dirty", "scenario 2");
  assert.equal(byPath.get("other.txt"), "new-dirty", "scenario 3");
  assert.equal(byPath.get("already-dirty.txt"), "modified-since", "scenario 7: 確度注記の対象");
  assert.equal(cmp.changed.length, 3);
  rmSync(repo, { recursive: true, force: true });
});

// Test 46 — baseline にあって現在 dirty でない = 元に戻された/コミットされた → 違反にしない。
test("46: files reverted or committed since baseline are not violations", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");
  write(repo, "a.txt", "dirty\n");
  write(repo, "b.txt", "untracked\n");

  const baseline = baselineFrom(repo);

  // a.txt を元に戻し、b.txt をコミットする
  write(repo, "a.txt", "v1\n");
  commitAll(repo, "commit b");

  const cmp = compareToBaseline(baseline, readRepoState(repo));
  assert.deepEqual(cmp.changed, [], "消えた dirty は違反ではない");
  assert.ok(cmp.headMoved, "シナリオ6: HEAD 移動は参考情報として検知される");
  assert.notEqual(cmp.headMoved.baselineSha, cmp.headMoved.currentSha);
  rmSync(repo, { recursive: true, force: true });
});

// Test 47 — rename: 新旧どちらのパスも変更として出す。宣言外のファイルを宣言済みの名前へ
// 改名して検査をすり抜ける経路を塞ぐため。
test("47: a rename reports both the new and the old path", () => {
  const repo = makeGitRepo();
  write(repo, "old-name.txt", "v1\n");
  commitAll(repo, "init");

  const baseline = baselineFrom(repo);
  assert.deepEqual(baseline.dirty, [], "clean な状態から開始");

  git(repo, "mv", "old-name.txt", "new-name.txt");

  const cmp = compareToBaseline(baseline, readRepoState(repo));
  const paths = cmp.changed.map((c) => c.path).sort();
  assert.deepEqual(paths, ["new-name.txt", "old-name.txt"]);
  rmSync(repo, { recursive: true, force: true });
});

// Test 48 — 削除は sha256: null で表現され、新規の削除は変更として出る。
test("48: deletions are recorded with a null hash", () => {
  const repo = makeGitRepo();
  write(repo, "keep.txt", "v1\n");
  write(repo, "gone.txt", "v1\n");
  commitAll(repo, "init");

  const baseline = baselineFrom(repo);
  rmSync(path.join(repo, "gone.txt"));

  const state = readRepoState(repo);
  const deleted = state.dirty.find((d) => d.path === "gone.txt");
  assert.ok(deleted, "削除は status に現れる");
  assert.equal(deleted.sha256, null, "削除済みファイルのハッシュは null");

  const cmp = compareToBaseline(baseline, state);
  assert.deepEqual(cmp.changed.map((c) => c.path), ["gone.txt"]);
  rmSync(repo, { recursive: true, force: true });
});

// Test 49 — シナリオ8: gitignore 済みは status に現れないので自然に除外される。
test("49: ignored build output never reaches the comparison (scenario 8)", () => {
  const repo = makeGitRepo();
  write(repo, ".gitignore", "dist/\nnode_modules/\n");
  commitAll(repo, "init");

  const baseline = baselineFrom(repo);
  write(repo, "dist/bundle.js", "generated\n");
  write(repo, "node_modules/pkg/index.js", "dep\n");

  const cmp = compareToBaseline(baseline, readRepoState(repo));
  assert.deepEqual(cmp.changed, [], "ignore 済みは git status に出ない");
  rmSync(repo, { recursive: true, force: true });
});

// Test 50 — 空リポジトリ（headSha: null）でも比較が落ちない。シナリオ6の判定が null を踏む経路。
test("50: comparison survives a null headSha on both sides", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "a\n");

  const baseline = baselineFrom(repo);
  assert.equal(baseline.headSha, null);

  // まだコミットしていない: 両方 null -> headMoved は null
  write(repo, "b.txt", "b\n");
  const before = compareToBaseline(baseline, readRepoState(repo));
  assert.equal(before.headMoved, null, "null === null なので移動していない");
  assert.deepEqual(before.changed.map((c) => c.path), ["b.txt"]);

  // 初回コミットで null -> SHA になる
  commitAll(repo, "init");
  const after = compareToBaseline(baseline, readRepoState(repo));
  assert.ok(after.headMoved, "null から SHA への変化も HEAD 移動として検知する");
  assert.equal(after.headMoved.baselineSha, null);
  assert.ok(after.headMoved.currentSha);
  rmSync(repo, { recursive: true, force: true });
});

// Test 51 — ignoreCase が baseline と現在で食い違う場合は安全側(case-sensitive)へ倒す。
test("51: a mismatched ignoreCase falls back to case-sensitive", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "a\n");
  commitAll(repo, "init");

  const state = readRepoState(repo);
  const strict: Baseline = { ...baselineFrom(repo), ignoreCase: false };
  const loose: Baseline = { ...baselineFrom(repo), ignoreCase: true };

  assert.equal(compareToBaseline(strict, { ...state, ignoreCase: true }).ignoreCase, false);
  assert.equal(compareToBaseline(loose, { ...state, ignoreCase: false }).ignoreCase, false);
  assert.equal(compareToBaseline(loose, { ...state, ignoreCase: true }).ignoreCase, true, "両方 true のときだけ同一視する");
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// baseline の取得 — 罠1（resume での再取得）
// ---------------------------------------------------------------------------

// Test 52 — captureIfAbsent は同一 (step, fixAttempts) では取り直さない。
// ここが壊れると、Codex が既に行った変更が baseline へ吸収されて検査が無言で無効化される。
test("52: captureIfAbsent never re-captures for the same (step, fixAttempts)", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");

  const { root, config } = makeRoot();
  const cfg = { ...config, settings: { ...config.settings, repoRoot: repo } };
  const capturedFor = { step: "implementation", fixAttempts: 0 };

  const first = captureIfAbsent(root, cfg, capturedFor);
  assert.equal(first.kind, "captured");
  assert.deepEqual(first.kind === "captured" ? first.baseline.dirty : null, []);

  // Codex が変更を加えた後に resume 相当で再度呼ばれる
  write(repo, "codex-made-this.txt", "leak\n");
  const second = captureIfAbsent(root, cfg, capturedFor);
  assert.equal(second.kind, "already-current", "再取得してはいけない");
  assert.deepEqual(
    readBaseline(root)?.dirty,
    [],
    "baseline は空のまま。Codex の変更が吸収されていない"
  );

  // fixAttempts が進めば別の baseline になる（per-step baseline）
  const third = captureIfAbsent(root, cfg, { step: "fix", fixAttempts: 1 });
  assert.equal(third.kind, "captured");
  assert.deepEqual(readBaseline(root)?.dirty.map((d) => d.path), ["codex-made-this.txt"]);
  rmSync(repo, { recursive: true, force: true });
});

// Test 53 — recaptureBaseline は無条件に取り直す（`aiw baseline capture` の実体）。
test("53: recaptureBaseline re-fixes the baseline unconditionally", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");

  const { root, config } = makeRoot();
  const cfg = { ...config, settings: { ...config.settings, repoRoot: repo } };
  const capturedFor = { step: "fix", fixAttempts: 1 };

  captureIfAbsent(root, cfg, capturedFor);
  write(repo, "human-edit.txt", "false positive source\n");

  const again = recaptureBaseline(root, cfg, capturedFor);
  assert.equal(again.kind, "captured", "同一キーでも取り直す");
  assert.deepEqual(readBaseline(root)?.dirty.map((d) => d.path), ["human-edit.txt"]);
  rmSync(repo, { recursive: true, force: true });
});

// Test 54 — checkRepoRoot の解決。settings.repoRoot 優先、未指定なら自動解決。
test("54: checkRepoRoot resolves from settings, then falls back to git", () => {
  const repo = makeGitRepo();
  write(repo, "a.txt", "a\n");
  commitAll(repo, "init");

  const { root, config } = makeRoot();

  const explicit = resolveCheckRepoRoot(root, { ...config, settings: { ...config.settings, repoRoot: repo } });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.ok && explicit.source, "settings.repoRoot");

  const missing = resolveCheckRepoRoot(root, {
    ...config,
    settings: { ...config.settings, repoRoot: path.join(repo, "does-not-exist") }
  });
  assert.equal(missing.ok, false, "存在しない指定は例外ではなく ok:false");

  // makeRoot() は tmpdir 配下でリポジトリではないので自動解決は失敗するはず
  const auto = resolveCheckRepoRoot(root, config);
  assert.equal(typeof auto.ok, "boolean", "失敗しても例外を投げない");
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 宣言源のパース
// ---------------------------------------------------------------------------

// Test 55 — 実物の書式（list item + インラインコード + 括弧の付記）。
test("55: declared paths come from the first inline code of a list item", () => {
  assert.equal(parseDeclaredLine("- `src/a.ts`（`:49-50`）"), "src/a.ts");
  assert.equal(parseDeclaredLine("* `src/b.ts` — 説明"), "src/b.ts");
  assert.equal(parseDeclaredLine("1. `src/c.ts`"), "src/c.ts");
  assert.equal(parseDeclaredLine("- src/d.ts （コードなし）"), "src/d.ts");
  assert.equal(parseDeclaredLine("- src\\windows\\e.ts"), "src/windows/e.ts");
  assert.equal(parseDeclaredLine("本文であって list item ではない"), null);
  assert.equal(parseDeclaredLine("-"), null);
});

// Test 56 — セクション欠落と「宣言ゼロ」を型で区別する（罠5）。
test("56: a missing section and an empty section are different results", () => {
  const withItems = "## Modify\n\n- `src/a.ts`\n- `src/dir/`\n\n## Reference\n- `x`\n";
  const declared = parseDeclaredFiles(withItems, "## Modify");
  assert.equal(declared.ok, true);
  assert.deepEqual(declared.ok && declared.files, ["src/a.ts"]);
  assert.deepEqual(declared.ok && declared.dirPrefixes, ["src/dir/"], "末尾 / はディレクトリ prefix");

  // 見出しはあるが項目ゼロ -> ok:true の空配列。ok:false にしない
  const empty = parseDeclaredFiles("## Modify\n\n（今回は変更なし）\n\n## Reference\n", "## Modify");
  assert.equal(empty.ok, true, "宣言ゼロは欠落ではない");
  assert.deepEqual(empty.ok && empty.files, []);

  // 見出しが無い -> ok:false（failed へ倒す。skipped にしない）
  const missing = parseDeclaredFiles("# Files\n\n## Read\n- `x`\n", "## Modify");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "section-missing");

  // HTML コメント内の箇条書きは宣言として数えない
  const commented = parseDeclaredFiles("## Modify\n<!--\n- `src/commented.ts`\n-->\n- `src/real.ts`\n", "## Modify");
  assert.deepEqual(commented.ok && commented.files, ["src/real.ts"]);
});

// Test 57 — isDeclared: 完全一致 + ディレクトリ prefix + 大小文字。
test("57: isDeclared matches files, directory prefixes and honours case mode", () => {
  const declared = parseDeclaredFiles("## Modify\n- `src/a.ts`\n- `src/gen/`\n", "## Modify");

  assert.equal(isDeclared("src/a.ts", declared, false), true);
  assert.equal(isDeclared("src/b.ts", declared, false), false);
  assert.equal(isDeclared("src/gen/deep/x.ts", declared, false), true, "ディレクトリ prefix 配下は許可");

  assert.equal(isDeclared("SRC/A.ts", declared, false), false, "case-sensitive では別物");
  assert.equal(isDeclared("SRC/A.ts", declared, true), true, "case-insensitive では同一");

  // 宣言ゼロ -> 何も許可されない（全変更が違反候補）
  const none = parseDeclaredFiles("## Modify\n", "## Modify");
  assert.equal(isDeclared("anything.ts", none, false), false);

  // セクション欠落 -> 同じく何も許可しない（判定は呼び出し側が failed にする）
  const missing = parseDeclaredFiles("# Other\n", "## Modify");
  assert.equal(isDeclared("anything.ts", missing, false), false);
});

// Test 58 — recaptureBaseline の import 元を機械的に固定する。
// コメントだけだと将来 engine/ 配下から呼ばれても気付けない。captureIfAbsent に force 引数を
// 持たせなかった意味が失われるので、ここで検査する。
test("58: recaptureBaseline is imported only by the interactive CLI", () => {
  const engineDir = path.join(process.cwd(), "src", "engine");
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith(".ts") && entry.name !== "gitScope.ts") {
        if (/\brecaptureBaseline\b/.test(readFileSync(abs, "utf8"))) {
          offenders.push(path.relative(process.cwd(), abs));
        }
      }
    }
  };
  walk(engineDir);

  assert.deepEqual(
    offenders,
    [],
    `recaptureBaseline must not be reachable from engine/: ${offenders.join(", ")}`
  );
});
