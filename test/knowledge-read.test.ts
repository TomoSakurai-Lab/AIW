// 知識ファイルへの到達の計器（2026-09-15）。
//
// research の初回実行（2026-09-14）は `context.md` を **Bash の grep / sed で**読んでいた。
// Read ツールしか数えない `filesRead` のままだと、観測項目 8 は「0 件＝知識が届いていない」という
// **実態と逆の結論**を出す。間違った計器は無い計器より悪いので、定義を持った別の計器を置く。
//
// ここで固定するのは「数え方の定義」そのもの（claude.ts の knowledgeTargets のコメントが正本）:
//   - Bash は 1 行目だけを、単語境界つきで見る
//   - ヒアドキュメント本文とリダイレクト先は数えない（書き込みは読み取りではない）
//   - 既知の過大計上（ファイル以外の引数として名前が出る）は定義どおり数える
//   - filesRead の意味は変えない / 判定には使わない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  bashKnowledgeReads,
  createClaudeExecutor,
  KNOWLEDGE_FILES,
  knowledgeTargets,
  readTargets
} from "../src/engine/executors/claude.js";
import { makeRoot } from "./helpers.js";

const assistant = (...blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });
const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });

// Test 162 — Bash の読み取りを数える。単語境界・書き込み・ヒアドキュメント本文を区別する。
test("162: knowledge reached through Bash is counted with word boundaries, while writes and heredoc bodies are not", () => {
  // 本番（2026-09-14 の research 初回）で実際に使われた形
  assert.deepEqual(
    bashKnowledgeReads('cd "C:/r/.ai-workflow" && grep -n "^## 索引" -A 200 context.md | head -250'),
    ["context.md"],
    "索引を grep で読んだ形"
  );
  assert.deepEqual(
    bashKnowledgeReads("cd \"C:/r/.ai-workflow\" && sed -n '1239,1480p' context.md"),
    ["context.md"],
    "該当節を sed で読んだ形"
  );
  assert.deepEqual(
    bashKnowledgeReads('head -40 "C:/r/.ai-workflow/instructions/local-environment-detail.md"'),
    ["local-environment-detail.md"],
    "引用符つきの絶対パス"
  );

  // ⚠️ 単語境界: 名前を含む別のファイルを数えない
  assert.deepEqual(bashKnowledgeReads("sed -n 1p error-context.md"), [], "error-context.md は context.md ではない");
  assert.deepEqual(bashKnowledgeReads("cat context-package.md"), []);
  assert.deepEqual(bashKnowledgeReads("cat context.md.bak"), []);

  // ⚠️ 書き込みは読み取りではない（リダイレクト先を除く）
  assert.deepEqual(bashKnowledgeReads("printf 'x' > context.md"), []);
  assert.deepEqual(bashKnowledgeReads('cat >> "C:/r/.ai-workflow/context.md" <<\'EOF\''), []);
  // 2>&1 は fd の複製であってリダイレクト先ではない。読み取りを消さない
  assert.deepEqual(bashKnowledgeReads("grep -c x context.md 2>&1"), ["context.md"]);

  // ⚠️ ヒアドキュメント本文に名前が出ても数えない（本番で research-findings.md を書いたときに実際にあった形）
  assert.deepEqual(
    bashKnowledgeReads(
      "cat > \"C:/r/.ai-workflow/research-findings.md\" <<'EOF'\n# Current Behavior\ncontext.md の索引から読んだ\nEOF"
    ),
    []
  );

  // 既知の過大計上（定義どおり数える。取りこぼしより害が小さい側に倒している）
  assert.deepEqual(bashKnowledgeReads('grep -rn "context.md" docs/'), ["context.md"]);
});

// Test 163 — knowledgeTargets は Read / Grep / Bash を合わせて数え、filesRead の意味は変えない。
test("163: knowledgeRead combines Read, Grep and Bash, while filesRead keeps its Read-only meaning", () => {
  const ev = assistant(
    { type: "tool_use", name: "Read", input: { file_path: "C:/r/.ai-workflow/instructions/local-environment-detail.md" } },
    { type: "tool_use", name: "Grep", input: { pattern: "索引", path: "C:\\r\\.ai-workflow\\context.md" } },
    { type: "tool_use", name: "Glob", input: { pattern: "**/context.md" } },
    bash("sed -n '1,5p' context.md")
  );
  assert.deepEqual(knowledgeTargets(ev).sort(), ["context.md", "local-environment-detail.md"]);

  // Read だけを見る計器は Bash / Grep の到達を見落とす——これが直した欠陥
  assert.deepEqual(readTargets(ev), ["local-environment-detail.md"], "filesRead は Read のみ（意味を変えない）");

  // Glob は一覧を返すだけで中身を読まない
  assert.deepEqual(knowledgeTargets(assistant({ type: "tool_use", name: "Glob", input: { pattern: "context.md" } })), []);
  // basename は完全一致（Read でも境界を守る）
  assert.deepEqual(knowledgeTargets(assistant({ type: "tool_use", name: "Read", input: { file_path: "C:/r/error-context.md" } })), []);

  // 監視対象は観測項目 8 と同じ 2 本。増やすときは baseline と同時に
  assert.deepEqual([...KNOWLEDGE_FILES], ["context.md", "local-environment-detail.md"]);
});

// Test 164 — executor が knowledgeRead を観測用 meta として残す。判定は変えない。
test("164: the executor records knowledgeRead as observation-only meta", async () => {
  const { root, config } = makeRoot();
  mkdirSync(path.join(root, ".claude-home"), { recursive: true });
  const lines = [
    assistant(
      bash('grep -n "^## 索引" -A 200 context.md'),
      { type: "tool_use", name: "Read", input: { file_path: "C:/x/src/a.ts" } }
    ),
    { type: "result", subtype: "success", is_error: false, usage: {} }
  ];
  const launch = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handlers: { close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
    setTimeout(() => {
      for (const l of lines) {
        stdout.write(`${JSON.stringify(l)}\n`);
      }
      stdout.end();
      handlers.close?.(0, null);
    }, 1);
    return {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => handlers.close?.(null, "SIGTERM" as NodeJS.Signals),
      on(event: string, cb: any) {
        if (event === "close") handlers.close = cb;
      }
    };
  };

  const result = await createClaudeExecutor({ launch }).execute({
    root,
    config,
    step: config.steps["improve-check"],
    projectRoot: root
  });

  assert.deepEqual((result.meta as any).knowledgeRead, ["context.md"], "Bash の grep で索引を読んだ到達を数える");
  assert.deepEqual((result.meta as any).filesRead, ["a.ts"], "filesRead の意味は変えない（Read のみ）");
  // ⚠️ 観測であって判定ではない
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, undefined);
});
