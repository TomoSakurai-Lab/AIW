# M2 Stage 5: 機構移行レポート

M2 の狙いは「プロンプトに書いて気をつける」を「構造で保証する」へ移すことだった。
このレポートは **どこまで移せて、どこが文章のまま残ったか** を正直に並べる。

前提として、これまでの実測はこうである:

> **ドキュメントに書いた規則は繰り返し破られ、型・テスト・validator に落とした規則は破られていない。**

したがって「Skill へ移した」は前進だが**まだ文章のまま**であり、
機構化の完了ではない。ここを曖昧にすると M2 の成果を過大評価する。

---

## 1. すでに機構になっているもの

M2 以前から、あるいは M2 の副産物として、**破れば止まる**ようになっている規則。

| 元の文章 | 現在の機構 | 破ったときの挙動 |
| --- | --- | --- |
| 「必須見出しをこの順序で」 | `artifact-contract` validator | halt（review / research）/ report（implementation） |
| 「`result` の許可値は〜」 | `transitions` のキー照合 | `invalid-status` で halt。許可値を表示 |
| 「Scope 外を変更しない」 | `diff-scope` validator | implementation は report、fix は **halt** |
| 「型エラーを残さない」 | `verify-local` validator | report + `test-report.md` を review へ |
| 「`current-status.json` は3フィールド」 | `json-schema` validator | halt |
| 「context-package を膨らませない」 | `token-range` validator | halt |
| 「検証していないものを passed にしない」 | `ValidatorStatus` の三値型 | 型として `skipped` を潰せない |
| 「Skill を読ませる」 | `assembleStepPrompt` の宣言必須 | `PromptAssemblyError` で**プロンプトを配らない** |
| 「宣言した Skill を assets に入れ忘れない」 | Test 88 | テストが落ちる |

最後の2つが M2 で足された分である。

---

## 2. 文章のまま残ったもの（Skill / Instructions へ移しただけ）

**破っても何も起きない。** 移行先が変わって重複が減っただけで、強制力は増えていない。

| 規則 | 置き場所 | なぜ機構化していないか |
| --- | --- | --- |
| AC ごとに1ブロック書く | Skill (implementation) | `## Acceptance Criteria Verification` の**中身**は契約の対象外。見出しの存在しか検査していない |
| 三値を二値へ潰さない | Instructions (coding-rules) | 同上。`Status:` の語彙を機械的に検査していない |
| Evidence は実在するものだけ | Instructions (coding-rules) | 実在確認は review（人間 + AI）が担う。自動化するにはテスト名の解決が要る |
| Fix で触れていない AC を PASS のまま残さない | Skill (fix) | 前回の `current-result.md` との差分比較が要る。実装可能だが未着手 |
| Backlog は Trigger 必須 | Instructions (backlog-rules) | `backlog.md` に契約もスキーマも無い |
| Severity / Status の固定語彙 | Instructions (backlog-rules) | 同上 |
| tags は kebab-case・既存を再利用 | Skill (reflection) | `task-metadata.json` にスキーマが無い（下記） |
| metrics は読み取れる値のみ・推測しない | Skill (reflection) | 同上 |
| e2e は1コマンド・再試行しない | Instructions (coding-rules) | 実行コマンドはエンジンの外。検査する手段が無い |
| 監査4セクションで実際に突き合わせる | Skill (review) | 見出しの存在は検査できるが、中身が空でも通る |

**この表がそのまま次の作業リストになる。**

---

## 3. 推奨: `task-metadata.json` に json-schema を付ける

### 推奨実施時期: **M3 前**

### 根拠

- **既に validator が1本ある**。`reflection` の `file-exists` は
  `task-metadata.json` を targets に含めている（KI-02 の修正時に追加）。
  つまり「無ければ止める」までは出来ていて、「中身が正しいか」だけが空白
- **json-schema validator は実装済み**で `current-status.json` に対して動いている。
  新しい機構を作る必要がなく、`schemas/task-metadata.schema.json` を足して
  workflow.yaml に4行足すだけで済む
- **壊れても誰も気付かない場所**である。`task-metadata.json` は archive にしか残らず、
  読まれるのは「後からタスク一覧を見るとき」だけ。**壊れていることに気付くのは、
  検索したいと思った半年後**になる
- 実際に守らせたい規則が Skill の文章としてしか存在しない:
  `tags` の語彙、`metrics` を推測で埋めない、`notVerified` を 0 に丸めない、
  単発タスクでは `featureId` を `null` にする

### 具体的に何を検査するか

| フィールド | 検査 |
| --- | --- |
| `taskName` | 必須・kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`） |
| `summary` | 必須・非空文字列 |
| `tags` | 配列・各要素 kebab-case・`minItems: 1` |
| `featureId` / `phaseId` | `string` または `null`（**省略は不可**にする。書き忘れと「単発だから null」を区別する） |
| `metrics.*` | `integer` または `null`。**`0` と `null` を型として区別する** |
| `metrics.acceptanceCriteria` | `pass` / `fail` / `notVerified` の3キー必須 |

最後の2行が本命である。「読み取れないものは `null`」という Skill の指示は、
`0` を許す型のままでは**推測で 0 を書いても検出できない**。

### やらないこと

`metrics` の値が `current-result.md` の実態と一致するかは検査しない。
それは review の仕事であり、schema で見るのは**形だけ**にする。
形の検査と内容の検査を混ぜると、どちらも中途半端になる。

---

## 4. その次の候補（M3 以降）

優先度順。いずれも「壊れても気付かない」度合いで並べた。

1. **`backlog.md` の artifact-contract 化**
   Severity / Status の固定語彙と `Trigger:` 必須を機械検査する。
   ただし backlog は1ファイルに複数項目が並ぶ構造なので、
   `markdown-sections` 契約（順序付き部分列）では表現できない。
   項目単位の検査を足すか、backlog を構造化データにするかの設計判断が要る

2. **`## Acceptance Criteria Verification` の中身検査**
   `### AC-\d+` と `Status: (PASS|FAIL|NOT VERIFIED)` の対応を数える。
   `context-package.md` の AC Matrix と件数が合わなければ report。
   三値を潰す事故を**実際に検出できる**唯一の案

3. **Fix 前後の AC 状態比較**
   `attempts/result-<n>.md` は既に保存されている。前回 PASS だった AC が
   今回も PASS のまま、かつ Fix Scope に含まれていない場合に report を出す

---

## 5. まとめ

M2 で機構化されたのは **「Skill が欠けたらプロンプトを配らない」** の1点である。
これは小さく見えるが、**M3 以降で Skill に手順を集約していく前提を守る**ための土台になる。

残りは正直に言えば「置き場所が整理された」段階にある。
2 の表を消化していくことが M2 の続きであり、
その第一歩として `task-metadata.json` の json-schema を **M3 前**に入れることを推奨する。
