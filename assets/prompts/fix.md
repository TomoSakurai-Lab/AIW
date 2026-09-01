# Current Phase

Fix

> role: codex。承認された Fix Scope のみを適用する。

手順は Skill、恒久規則は Project Instructions（いずれも上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Read

- `.ai-workflow/codex-system.md`
- `.ai-workflow/context-package.md`
- `.ai-workflow/current-review.md`
- `.ai-workflow/test-report.md`（存在する場合のみ = verify-local が失敗したとき）

## Output

- ソース変更（`current-review.md` の `## Fix Scope` > `### Files To Modify` のみ。**逸脱は即 halt**）
- `.ai-workflow/current-result.md` — Artifact Contract `current-result` に従い、作り直す
- `.ai-workflow/current-status.json`

### current-status.json

`step` はマップキー完全一致 `fix`。`reason` は必須（短い人間向け説明）。3 フィールドすべて出力する。
**`result` の許可値は `fixed` のみ。**

```json
{ "step": "fix", "result": "fixed", "reason": "<短い人間向け説明>" }
```
