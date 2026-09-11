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

1. `context.md` / `learnings.md` を更新する（判定基準は Project Instructions）。⚠️ **`context.md` に節を足した / 節の意味を変えたら、冒頭の `## 索引` にも同じ行を足す。**読み手（research）は索引しか見ないので、**本文にだけ書いた知識は次のタスクに届かない**
2. `current-review.md` の `## Backlog` を `backlog.md` へ転記する（書式は Project Instructions）
2b. **fix が見送った Fix Scope の Major を `backlog.md` へ積む**（下記）
3. **`research-findings.md` を消し込む**（下記・必須）
4. `research/` に後続タスクで参照される調査メモがあれば更新する。なければ触らない
5. `.ai-workflow/task-metadata.json` を書く（下記）
6. `.ai-workflow/current-status.json` を書く

## fix が見送った Major の転記

⚠️ **`## Backlog` だけを見ていると漏れる。** `current-review.md` は fix より**前**に
書かれるので、fix が「Scope 外へ波及するため見送る」と判断した Major は
そこには載っていない。載っているのは `current-result.md` の方である。

`current-result.md` に記録された**見送りの理由**を1件ずつ見て、`backlog.md` へ転記する:

- `Source:` は出典タスク ID + `current-result.md`（`current-review.md` ではない）
- `Severity:` は元の指摘に従う（Fix Scope の Major なので通常 `Major`）
- `Trigger:` は fix が書いた着手条件。無ければここで補う。
  **書けないなら転記しない**のではなく、書けるまで考える——
  improve-check を通過した見送りは「後でやる」と決めた項目であり、
  Trigger 無しで捨てると「通過したのに誰も拾わない」になる

> **この経路が無いと、見送りは improve-check を通過した時点で消える。**
> 見送りを通過扱いにする設計は、backlog へ積む担当がいて初めて成立する。

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

`.ai-workflow/task-metadata.json` に出力する。CLI が archive へ退避する。

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

成果物から**読み取れる値のみ**記入する。各キーの出典と数える時点:

| キー | 定義 |
| --- | --- |
| `acceptanceCriteria` | `current-result.md` の `## Acceptance Criteria Verification` の Status 三値の集計 |
| `openDecisions` | **reflection 時点で未解決のもののみ数える。** 上の消し込みで「未解決のまま残った」に分類し `backlog.md` へ転記した件数。**実装中に解決済みになった Open Decisions は含めない。** 判別は `research-findings.md` の `# Open Decisions` と実装・review の記録（`current-result.md` / `current-review.md`）の突き合わせによる |
| `manualVerificationRequired` | `current-result.md` の `## Manual Verification Required` の件数 |
| `highRiskChanges` | `current-result.md` の `## Risk Areas` の件数 |

`openDecisions` は research が挙げた総数**ではない**。総数は `aiw status --summary` が
`research-findings.md` の `# Open Decisions` から数える（＝消し込み前の時点）。
2つの値は時点が違うので一致しなくてよく、差分が「reflection で決着した件数」になる。

- 該当セクションが存在しない場合は、そのキーを `null` にする。
  `openDecisions` は `research-findings.md` に `# Open Decisions` セクションが無いとき `null`、
  全件決着したとき `0`。**null（計測不能）と 0（全件決着）を混同しない**
- **推測で数えない。** 読み取れないものは `null`
- `notVerified` を 0 に丸めない。未検証は未検証として数える
