# Current Phase

Research

手順は Skill、恒久規則は Project Instructions、環境固有の実行手順は
Local Environment（いずれも存在すれば上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Output

- `.ai-workflow2/context-package.md` — Artifact Contract `context-package` に従う。
  **Codex 入力**。token-range 検証あり（設定値は workflow.yaml が正本）
- `.ai-workflow2/research-findings.md` — Artifact Contract `research-findings` に従う。
  **人間とレビュアー向け**。トークン制約なし
- `.ai-workflow2/codex-prompt.md` — Artifact Contract `codex-prompt` に従う
- `.ai-workflow2/current-status.json`

### current-status.json

`step` はマップキー完全一致 `research`。`reason` は必須（短い人間向け説明）。3 フィールドすべて出力する。

**`result` の許可値はこの2つだけ**（`transitions` のキーと完全一致。他の値は
`invalid-status` で halt する）:

| result | 意味 |
| --- | --- |
| `research-complete` | 成果物3点が揃い、実装へ進める |
| `ux-decision-required` | UX 判断が未確定。人間の記入待ち（research を再実行する） |

```json
{ "step": "research", "result": "research-complete", "reason": "<短い人間向け説明>" }
```
