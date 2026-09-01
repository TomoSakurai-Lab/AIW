# Current Phase

Reflection

手順は Skill、恒久規則は Project Instructions（いずれも上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Input

- `.ai-workflow/current-task.md` — 今回のタスク定義
- `.ai-workflow/current-result.md` — 実装結果
- `.ai-workflow/current-review.md` — レビュー結果（`## Backlog` を含む）
- `.ai-workflow/research-findings.md` — research の調査結果（`# Open Decisions` / `# Risk Areas` の消し込み対象）
- `.ai-workflow/context-package.md` — 実装へ渡した宣言
- `.ai-workflow/context.md` — プロジェクト長期コンテキスト（更新対象）
- `.ai-workflow/learnings.md` — 教訓（更新対象）
- `.ai-workflow/backlog.md` — 未着手項目（更新対象）
- `.ai-workflow/feature.md` — feature 定義と Phase list（存在する場合）
- `.ai-workflow/research/` — 調査メモ（更新対象）

## Output

- `.ai-workflow/context.md` / `learnings.md` / `backlog.md` / `research/`（更新）
- `.ai-workflow/task-metadata.json`
- `.ai-workflow/current-status.json`

### current-status.json

`step` はマップキー完全一致 `reflection`。
`result` は `feature-complete` または `feature-continue`。`reason` は必須。

```json
{ "step": "reflection", "result": "feature-complete", "reason": "<短い人間向け説明>" }
```

`feature-continue` の場合は `nextPhaseId` も必須。その値は
**`feature.md` の Phase list に存在する Phase ID** とする
（存在しない ID は `invalid-status` で halt する）。

```json
{ "step": "reflection", "result": "feature-continue", "reason": "<短い説明>", "nextPhaseId": "<feature.md の Phase ID>" }
```
