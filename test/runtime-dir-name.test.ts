// ランタイムディレクトリ名の集約（RUNTIME_DIR_NAME）と、リネーム移行ガード。
//
// 背景: `.ai-workflow2/` → `.ai-workflow/` の改名。エンジンだけ先に新名になり、
// ディレクトリがまだ旧名のままだと、resolveRoot は探索に失敗して
// **存在しないパスをフォールバックで返す**。そこへ `aiw init` が走ると
// 中身の無いランタイムが生まれ、file-exists が素通りする形になる（KI-09 の典型）。
//
// ⚠️ このテストは**実配置を模倣する**: 検査対象リポジトリの中にランタイムがあり、
// ランタイムは `config/workflow.yaml` を持つ、という本番と同じ形を作る。
// マーカーの無いディレクトリを置いて通してしまうと、テストが本番と別の土俵になる
// （docs/new-artifact-checklist.md の9点目）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_MARKER, PRE_RENAME_DIR_NAME, RUNTIME_DIR_NAME, resolveRoot } from "../src/engine/paths.js";

// ランタイムらしいディレクトリ（config/workflow.yaml を持つ）を作る。
// マーカーが無いと resolveRoot はそこをランタイムと見なさない——本番と同じ判定条件。
function makeRuntime(parent: string, name: string): string {
  const root = path.join(parent, name);
  mkdirSync(path.join(root, path.dirname(CONFIG_MARKER)), { recursive: true });
  writeFileSync(path.join(root, CONFIG_MARKER), "version: 5\n", "utf8");
  return root;
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "aiw-dirname-"));
}

test("runtime dir name: resolveRoot finds the runtime by the shared constant", () => {
  const repo = scratch();
  const expected = makeRuntime(repo, RUNTIME_DIR_NAME);
  const nested = path.join(repo, "src", "deep");
  mkdirSync(nested, { recursive: true });

  // 子ディレクトリからでも上へ探索して見つかる（本番の呼ばれ方）
  assert.equal(resolveRoot(undefined, nested), expected);
  assert.equal(resolveRoot(undefined, repo), expected);
});

// ⚠️ **これが移行ガードの本体。** 新名が無く、旧名のランタイムが実在する状況。
test("runtime dir name: an un-renamed runtime halts instead of falling back", () => {
  const repo = scratch();
  makeRuntime(repo, ".ai-workflow2"); // 改名前のまま
  const nested = path.join(repo, "src");
  mkdirSync(nested, { recursive: true });

  assert.throws(
    () => resolveRoot(undefined, nested, { runtimeDirName: ".ai-workflow", preRenameDirName: ".ai-workflow2" }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /\.ai-workflow2 が見つかりました/, "何が見つかったかを言う");
      assert.match(m, /リネーム移行が必要です/, "何をすべきかを言う");
      return true;
    },
    "**黙って新しいパスを返してはいけない**（空のランタイムを作らせる経路になる）"
  );
});

// ガードは「旧名が実在するとき」だけ働く。まっさらな場所では従来どおり
// フォールバックしないと `aiw init` で新規に作れなくなる。
test("runtime dir name: a clean directory still falls back so init can scaffold", () => {
  const repo = scratch();
  const got = resolveRoot(undefined, repo, { runtimeDirName: ".ai-workflow", preRenameDirName: ".ai-workflow2" });
  assert.equal(got, path.resolve(repo, ".ai-workflow"), "旧名が無いならフォールバックする");
});

// 改名済みの環境ではガードが黙る。旧名ディレクトリが残っていても、
// **新名が見つかればそちらが勝つ**（退避した legacy が残っている期間の挙動）。
test("runtime dir name: the renamed runtime wins even while the old directory lingers", () => {
  const repo = scratch();
  makeRuntime(repo, ".ai-workflow2"); // 退避し損ねた旧ランタイム
  const renamed = makeRuntime(repo, ".ai-workflow");

  const got = resolveRoot(undefined, repo, { runtimeDirName: ".ai-workflow", preRenameDirName: ".ai-workflow2" });
  assert.equal(got, renamed);
});

// 明示指定と AIW_ROOT はガードより優先される（従来の契約を変えない）。
test("runtime dir name: an explicit root bypasses the guard", () => {
  const repo = scratch();
  makeRuntime(repo, ".ai-workflow2");
  const explicit = path.join(repo, "elsewhere");

  assert.equal(
    resolveRoot(explicit, repo, { runtimeDirName: ".ai-workflow", preRenameDirName: ".ai-workflow2" }),
    path.resolve(explicit)
  );
});

// 段階2の状態を固定する: 定数はまだ改名前の名前。
// ⚠️ この assertion は**段階3で落ちるのが正しい**。落ちたら定数を切り替えた合図として
// この期待値を `.ai-workflow` へ直す（テストを消すのではなく期待値を動かす）。
test("runtime dir name: stage 2 keeps the constant at the pre-rename value", () => {
  assert.equal(RUNTIME_DIR_NAME, ".ai-workflow2", "段階2ではまだ改名しない（既存環境が動き続ける）");
  assert.equal(PRE_RENAME_DIR_NAME, ".ai-workflow2", "移行元の名前は固定");
});
