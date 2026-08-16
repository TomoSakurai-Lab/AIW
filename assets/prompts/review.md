# Current Phase

Review

手順は Skill、恒久規則は Project Instructions（いずれも上に結合済み）にある。
このプロンプトはこのステップ固有の宣言だけを持つ。

## Output

- `.ai-workflow2/current-review.md` — Artifact Contract `current-review` に従う。
  承認された Fix Scope がそのまま Fix の契約になる
- `.ai-workflow2/current-status.json`

### current-status.json

`step` はマップキー完全一致 `review`。`reason` は必須。3 フィールドすべて出力する。

**`result` の許可値はこの2つだけ**（`transitions` のキーと完全一致）:

| result | 意味 |
| --- | --- |
| `ready` | Critical / Major なし。reflection へ進む |
| `fix-required` | Critical / Major あり。Fix Scope が Fix の契約になる |

> **`approved` / `approve` は無効。** これは `result` ではなく**承認ゲートの操作**であり、
> `aiw approve` コマンドが担当する。`result` に書くと `invalid-status` で halt する。
> 実測で 2 分間に 4 回（`approved` ×2 → `approve` ×2）繰り返した事故がある。
> **綴りを変えて再試行しても直らない。** `ready` か `fix-required` を書くこと。
>
> レビュー結果の「承認する／しない」は人間が `aiw approve` / `aiw reject` で行う。
> このステップが宣言するのは「**実装に Critical / Major があるか**」だけ。

```json
{ "step": "review", "result": "ready", "reason": "<短い人間向け説明>" }
```
