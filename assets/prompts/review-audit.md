# Current Phase

Review Audit

> セッションは必ず新規（session: fresh）。実装レビューの繰り返しではなく、レビュー自体の品質を監査する。

## Output 構造

- audit-report.md（Audit Summary / Missing Critical / Missing Major / Wrong Severity /
  Missing Review Points / Fix Scope Audit / Review Quality Score / Suggestions）
- current-status.json（下記の完全な形で出力する）

`step` はマップキー完全一致 `review-audit`。`reason` は必須（短い人間向け説明）。3 フィールドすべて出力する。

```json
{ "step": "review-audit", "result": "audit-complete", "reason": "<短い人間向け説明>" }
```
