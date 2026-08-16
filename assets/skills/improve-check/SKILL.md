# Skill: Improve Check

improve-check ステップの判断手順。**このステップは成果物を作らない**。
`current-status.json` に二値判定を返すだけで、修正も追記もしない。

## 手順

1. `.ai-workflow2/current-review.md` の `## Critical` を1件ずつ取り出す
2. 各件について `.ai-workflow2/current-result.md` と `git-diff` で**実際に解消されたか**を確かめる。
   「直したと書いてある」ではなく、差分に対応する変更があるかを見る
3. 未解消の Critical が1件でもあれば `fix-incomplete`、全解消なら `ready-for-reflection`

## `NOT VERIFIED` の扱い

判断材料として `.ai-workflow2/current-result.md` の `## Acceptance Criteria Verification` を見るとき、
**`NOT VERIFIED` は「検証済み」ではない**。

ただし未検証の AC が残っていても、それが Critical でなければ `ready-for-reflection` でよい。
未検証であること自体は review と `aiw status --summary` が可視化する。
このステップが判定するのは「**Critical が解消されたか**」だけである。

## current-status.json を書くときの事故

**`step` を `improve-check` に書き直すこと。** `current-status.json` は前ステップ
（`fix` や `review`）の宣言が残ったままなので、`result` だけ直して `step` を放置すると
`status.step ≠ 実行 step` で弾かれる。実測でこの事故が起きている
（`status.step "review"` のまま `improve-check` を実行）。**3フィールドすべて書き直す。**
