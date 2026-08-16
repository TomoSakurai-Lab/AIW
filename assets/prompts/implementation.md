# Current Phase

Implementation

> role: codex。task 単位セッションで実行する。長期コンテキスト全体は読まない。

手順は Skill、恒久規則は Project Instructions（いずれも上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Read

- `.ai-workflow2/codex-system.md`
- `.ai-workflow2/context-package.md`
- `.ai-workflow2/codex-prompt.md`

## Output

- ソース変更（`codex-prompt.md` の `# Scope Boundaries` / `# Required Changes` の範囲内のみ）
- `.ai-workflow2/current-result.md` — Artifact Contract `current-result` に従う
- `.ai-workflow2/current-status.json`

### current-status.json

`step` はマップキー完全一致 `implementation`。`reason` は必須（短い人間向け説明）。
3 フィールドすべて出力する。**`result` の許可値は `implemented` のみ。**

```json
{ "step": "implementation", "result": "implemented", "reason": "<短い人間向け説明>" }
```
