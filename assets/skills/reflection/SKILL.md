# Skill: Reflection

reflection ステップで毎回同じように行う手順。

## 目的

完了した作業を**再利用可能なプロジェクト知識へ変換する。**

今回の経過そのものは archive に残るので、ここで書くのは
「**次のタスクで読まれる価値があるもの**」だけに絞る。

## 責務境界

**AI は成果物を書き、宣言する。状態変更は CLI が実行する。**

| 担当 | 内容 |
| --- | --- |
| **AI（このステップ）** | `context.md` / `learnings.md` / `backlog.md` / `research/` の更新、`task-metadata.json` の生成、`current-status.json` の宣言 |
| **CLI（postActions）** | archive への退避、テンプレート復元、`fixAttempts` リセット、phase 更新 |

### やらないこと

- archive ディレクトリへのファイルコピー（CLI が実行する）
- `current-*.md` のテンプレートへの差し戻し（CLI が実行する）
- 任意のファイル削除
- `feature.md` の Phase 状態の書き換え（CLI の `advancePhase` が実行する）
- 知識ファイルへの、今回の作業経過の転記

AI がやると二重処理になる。

## 手順

1. `context.md` / `learnings.md` を更新する（判定基準は Project Instructions）
2. `current-review.md` の `## Backlog` を `backlog.md` へ転記する（書式は Project Instructions）
3. **`research-findings.md` を消し込む**（下記・必須）
4. `research/` に後続タスクで参照される調査メモがあれば更新する。なければ触らない
5. `.ai-workflow2/task-metadata.json` を書く（下記）
6. `.ai-workflow2/current-status.json` を書く

## research-findings.md の消し込み ← 必須

**research が出した未解決事項を、ここで必ず決着させる。**
消し込む担当がいないと、タスクを重ねるごとに未解決の判断が溜まり、
`# Open Decisions` は「出すだけ出して誰も見ない欄」になる。

`research-findings.md` は次タスクの research が上書きするため、
**このステップが最後の参照機会**である（CLI が archive へ退避する）。

### `# Open Decisions` — 1件ずつ結論を出す

| 分類 | 対応 |
| --- | --- |
| **実装時に決定された** | どう決まったかを1行で確認する。判断が今後も効くものは `context.md` へ |
| **未解決のまま残った** | **`backlog.md` へ転記する**（出典タスク ID 付き） |
| **不要になった** | 前提が変わって判断自体が消えたなら、そう記録して終わり |

未解決を転記するときは `Severity: 仕様判断` を使い、`Trigger:` に
「その仕様が決まったとき」など着手条件を書く。人間の意思決定待ちなら
`Status: blocked (<待っている決定>)` にする。

> **無断確定を見逃さない。** `current-review.md` の `## Risk Area Audit` が
> 「Open Decisions が実装で無断確定されていないか」を監査している。
> 監査で指摘されているのに backlog へ残っていない項目がないか突き合わせる。

### `# Risk Areas` — 監査されたかを確認する

各項目が `current-review.md` の `## Risk Area Audit` で扱われたかを確認する。

- **監査され、問題なしと判断された** → 何もしない
- **監査され、指摘になった** → Fix 済みか、`backlog.md` に残っているかを確認する
- **監査されずに残った** → 見落としなので、`learnings.md`（再発防止の知見になる場合）か
  `backlog.md`（未確認のリスクとして残す場合）へ記録する。**黙って捨てない**

## task-metadata.json

`.ai-workflow2/task-metadata.json` に出力する。CLI が archive へ退避する。

```json
{
  "featureId": "<feature.md の feature ID。単発タスクなら null>",
  "featureName": "<人間向けの feature 名。単発タスクなら null>",
  "phaseId": "<現在の Phase ID。マルチフェーズでなければ null>",
  "phaseName": "<Phase 名。同上>",
  "taskName": "<このタスクの短い識別名。kebab-case>",
  "summary": "<何をやったか 1-2 文。後から一覧で読む用>",
  "tags": ["<下記の規則に従う>"],
  "metrics": {
    "acceptanceCriteria": { "pass": 0, "fail": 0, "notVerified": 0 },
    "openDecisions": 0,
    "manualVerificationRequired": 0,
    "highRiskChanges": 0
  }
}
```

### tags

小文字 kebab-case。以下の分類から必要なものを選ぶ。

| 分類 | 例 |
| --- | --- |
| 領域 | `frontend` / `backend` / `db` / `infra` / `ci` |
| 種別 | `feature` / `bugfix` / `refactor` / `investigation` / `migration` |
| 技術 | `react` / `vue` / `dotnet` / `sql` など |
| 特性 | `breaking-change` / `security` / `performance` |

**既存の archive にある metadata の tags を優先的に再利用する。**
表記ゆれ（`bug-fix` と `bugfix` など）が混ざると検索に使えなくなる。

### metrics

`current-result.md` と `current-review.md` から**読み取れる値のみ**記入する。

- 該当セクションが存在しない場合は、そのキーを `null` にする
- **推測で数えない。** 読み取れないものは `null`
- `notVerified` を 0 に丸めない。未検証は未検証として数える
