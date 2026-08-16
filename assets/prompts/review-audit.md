# Current Phase

Review Audit

> **対象ディレクトリ**: ワークフローのファイルはすべて `.ai-workflow2/` 配下（末尾 `2`）。読む入力も
> 書く成果物（`current-task.md` / `context-package.md` / `current-result.md` / `current-review.md`
> / `audit-report.md` / `current-status.json` 等）もすべて `.ai-workflow2/` 側を指す。同名ファイルを
> 持つ旧 `.ai-workflow/`（`2` なし）は別物で、参照・変更しない。

> セッションは必ず新規（session: fresh）。実装レビューの繰り返しではなく、レビュー自体の品質を監査する。

## Output 構造

- audit-report.md（Audit Summary / Missing Critical / Missing Major / Wrong Severity /
  Missing Review Points / Fix Scope Audit / Review Quality Score / Suggestions）
- current-status.json（下記の完全な形で出力する）

`step` はマップキー完全一致 `review-audit`。`reason` は必須（短い人間向け説明）。3 フィールドすべて出力する。

```json
{ "step": "review-audit", "result": "audit-complete", "reason": "<短い人間向け説明>" }
```
