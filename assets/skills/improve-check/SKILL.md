# Skill: Improve Check

improve-check ステップの判断手順。**このステップは成果物を作らない**。
`current-status.json` に二値判定を返すだけで、修正も追記もしない。

## 判定するもの

**Fix Scope は fix の契約である。** このステップは「契約どおり閉じたか」を見る。

| 対象 | 通過の条件 |
| --- | --- |
| `## Critical` 全件 | **解消**していること |
| **`## Fix Scope` の `### Major` 全件** | **解消**または**理由付き見送り**のいずれか |

⚠️ `## Major`（レビュー本文の一覧）ではなく **`## Fix Scope` の `### Major`** が対象。
Fix Scope に載らなかった Major は今回の契約に入っていない。

## 手順

1. `.ai-workflow/current-review.md` の `## Critical` と、`## Fix Scope` の `### Major` を
   1件ずつ取り出す
2. 各件について `.ai-workflow/current-result.md` と `git-diff` で**実際に解消されたか**を確かめる。
   **「直したと書いてある」ではなく、差分に対応する変更があるかを見る**（自己申告を信用しない）
3. 解消されていない Major については、`current-result.md` に**見送りの理由が書かれているか**を見る
4. 判定:
   - 未解消の Critical が1件でもある → `fix-incomplete`
   - **理由の記録が無いまま未解消の Major がある → `fix-incomplete`**
   - Critical 全解消かつ、Major が全件「解消」または「理由付き見送り」→ `ready-for-reflection`

## 理由付き見送りの扱い

見送りは**通過**とする（`fix-incomplete` にしない）。Scope 外へ波及する修正など、
**見送りが正しい判断である場合がある**ため。

- 見送りと認めるのは、`current-result.md` に**対象と理由が明記されている**場合のみ
- `reason` に見送り件数を含める（例: `Critical 2件解消 / Major 3件中1件は理由付き見送り`）
- 見送られた Major は **reflection が backlog へ積む**（reflection Skill 側で扱う）

⚠️ **黙って未解消は見送りではない。** 記述も理由も無いものは `fix-incomplete`。
この区別が無いと「書かなければ通る」になり、判定が自己申告の追認に落ちる。

⚠️ 見送りを乱発させないために `fixAttempts` の上限（初回 + 2）は**変えない**。
AI で収束しない Major は escalation で人間に渡すべき状況である、という設計は維持する。

## `NOT VERIFIED` の扱い

判断材料として `.ai-workflow/current-result.md` の `## Acceptance Criteria Verification` を見るとき、
**`NOT VERIFIED` は「検証済み」ではない**。

ただし未検証の AC が残っていても、それが Critical / Fix Scope の Major でなければ
`ready-for-reflection` でよい。未検証であること自体は review と `aiw status --summary` が可視化する。
このステップが判定するのは「**Fix Scope の契約が閉じたか**」である。

## current-status.json を書くときの事故

**`step` を `improve-check` に書き直すこと。** `current-status.json` は前ステップ
（`fix` や `review`）の宣言が残ったままなので、`result` だけ直して `step` を放置すると
`status.step ≠ 実行 step` で弾かれる。実測でこの事故が起きている
（`status.step "review"` のまま `improve-check` を実行）。**3フィールドすべて書き直す。**
