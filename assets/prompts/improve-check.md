# Current Phase

Improve Check

手順は Skill、恒久規則は Project Instructions（いずれも上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Goal

ブロッキングなレビュー指摘（Critical）が解消されたことを検証する。2 値判定を返す。

| result | 基準 |
|--------|------|
| `ready-for-reflection` | Critical 全解消 → reflection へ進む |
| `fix-incomplete` | 未解消の Critical が残存 → Fix へ差し戻し |

## Output

- `.ai-workflow2/current-status.json`

`reason` は必須。3 フィールドすべて出力する。
**`result` の許可値は上表の2つだけ**（`ready-for-reflection` / `fix-incomplete`）。
他の値は `invalid-status` で halt する（halt メッセージに許可値が表示される）。

> **テストの検証は validator が行う。** 型検査は `verify-local` が implementation / fix で
> 自動実行され、失敗すれば `test-report.md` として review へ渡り fix ループに乗る。
> このステップが「テストを実行させるために別ステップへ送る」ことはない。

```json
{ "step": "improve-check", "result": "ready-for-reflection", "reason": "<短い人間向け説明>" }
```
