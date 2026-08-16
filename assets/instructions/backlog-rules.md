# Project Instructions: Backlog

Backlog は「あとでやる」置き場ではなく、**いつやるかの引き金を言える項目だけ**の集約先。
引き金を言えないものを入れると、恒久的に消化されない項目が溜まり、本当にやるべき負債が埋もれる。

review が `## Backlog` に書き、reflection が `backlog.md` へ出典付きで転記する。
どちらの側でも同じ基準を使う。

## 入れてよい

- **引き金が言える**もの。「◯◯を次に触るとき」「△△の仕様が決まったら」
  「□□が N 件を超えたら」など、着手条件を1行で書けること。
  その条件を **`Trigger:` として必ず併記する**
- 今回のスコープ外だが、**放置すると別の作業が壊れる**もの

## 入れない（`## Minor` に書いて終わりにする）

- 「やれたら良い」「統一感のため」など、引き金を言えないもの
- 好みの問題、代替案の提示にとどまるもの
- 今回の変更と無関係に元からあり、誰も困っていないもの

`## Minor` に書いた内容は archive に残るので、後から必要になれば辿れる。
**Backlog に入れない＝失われる、ではない。**

## バックログ解消タスクの扱い

`current-task.md` が既存 Backlog 項目（`BL-xxx`）の解消を目的としている場合、
そのタスクの review が `## Backlog` に書けるのは **Critical / Major 相当のみ**。
新規 Minor は `## Minor` に留める。

掃除タスクが新しい掃除対象を生むと、Backlog は構造的に減らなくなる。

## backlog.md の書式

reflection が `current-review.md` の `## Backlog` を**出典タスク ID 付きで**転記する。
ただし **`Trigger:`（着手条件）が書かれていない項目は転記しない**。
上の基準を満たしていないため、`## Minor` として archive に残すだけでよい。

```md
## BL-001

- Source: <出典タスクID> / current-review.md <指摘ID>
- Severity: Minor
- Trigger: <着手条件を1行で>
- Summary: <内容>
- Status: open
```

`Severity` は**次の固定語彙のみ**を使う。自由記述にすると絞り込みも棚卸しもできなくなる:

| 値 | 意味 |
| --- | --- |
| `Minor` | 小さな改善。引き金が来たら着手 |
| `Major (deferred)` | 本来 Major だが今回のスコープ外 |
| `仕様判断` | 実装ではなく人間の意思決定待ち |
| `Feature` | 独立した feature として計画すべき規模 |

`Status` は `open` / `resolved (<解消タスクID>)` / `wontfix (<理由>)` / `blocked (<理由>)` のいずれか。

- `blocked` は **こちらの作業ではなく外部の意思決定を待っている**もの（仕様未確定など）に使う。
  やらないと決めた `wontfix` とは区別する。**task-planning は `blocked` を計画候補として扱わない。**
  引き金は「その仕様が決まったとき」なので `Trigger:` にそう書く
- **`wontfix` を積極的に使う。** 引き金が来ないまま古くなった項目、前提が変わって意味を
  失った項目は `wontfix` にし、理由を1行残す。open のまま放置しない
- 項目は**削除しない**（設計 §6.10）。`wontfix` も履歴として残す
- 今回のタスクが既存項目を解消したなら、該当項目を `resolved (<今回のタスクID>)` にする

## 溜まりすぎの検知

`backlog.md` の `Status: open` が **20 件を超えたら**、reflection は
`current-status.json` の `reason` に「backlog open <件数>件、棚卸し推奨」を併記して
人間に知らせる。
