# 設計: `aiw pr` v1（成果物から PR 説明文を生成し、Azure DevOps に draft PR を作る）

> 状態: **設計（承認待ち）**。2026-10-20 起票。
> 確定済みの判断（draft 固定・REST 直叩き・PAT は env のみ・state 不可触・ブランチを冪等キー・
> 失敗は report 相当・`--dry-run` 必須）は依頼文のとおりで、本書では再検討しない。
> 本書が決めるのは A〜E と、調べて分かった前提のずれ（§0）への対処。

### 人間の裁定（2026-10-20）

| 問 | 裁定 |
| --- | --- |
| Q1 PR の単位 | **feature = ブランチ = PR**（§E-3 (i)）。説明文は最新フェーズの成果物で更新。feature の集約は v2 |
| Q2 スクショ | **(a)** env で出力先を受ける既存 spec だけ（§C-2）。撮れた枚数を数えて (b) を判断 |
| Q3 変更ファイル | **`archiveArtifacts` に `context-package.md` を追加**。古い archive は `## Files Changed` へ落とし見出しで明示 |
| Q4 内部用語 | **ID 除去 + 定型語の置換だけ・draft で人が直す**。`--dry-run` で残りを数え、v2 で要約欄を判断 |

---

## 0. 調べて分かった前提のずれ（設計の前に）

実装前に現物を読んで、依頼文の前提と違っていた点。**どれも設計の選択に効く**ので先に並べる。

| # | 前提 | 実際 | 効く節 |
| --- | --- | --- | --- |
| Z1 | 「reflection 後」に成果物がある | reflection の postActions（`archiveArtifacts` → `restoreTemplates`）で `current-*.md` は **テンプレートへ戻る**。成果物の正本は `archive/<日付時刻>-<feature>/<日付時刻>-task/` | §1 |
| Z2 | 変更ファイルは context-package の `## Modify` から取る | **`context-package.md` は archive に退避されていない**（`archiveArtifacts` の対象一覧に無い）。root には次の research が上書きするまで残るが、どのタスクのものかを機械的に確かめられない | §A-2・判断 Q3 |
| Z3 | タスク=ブランチ運用 | 親リポは **`master` へ直接コミット**（直近 30 コミットで PR マージは 2 件・どちらも別ブランチの人の作業）。aiw 自身は git に書かない（コミットは人間）。commit の粒度は概ね feature 単位 | §E・判断 Q1 |
| Z4 | review が E2E 画面の after スクショを保存できる | review（claude executor）は **Bash が許可リスト制で書き込み不可**、Edit はパス限定で png は書けない、**spec の作成は禁止**。png が出せるのは「既存 spec がスクショの出力先を env で受ける」場合だけ（`GRID_SURFACE_SHOTS` 等・spec ごとに名前も形式もばらばら） | §C・判断 Q2 |
| Z5 | 説明文に task-metadata の summary を載せる | summary は**内部の記録文**（`BL-346` / `quarantine` / `phase 8` / spec 名・行番号が密集・1 件 500〜800 字）。機械的な置換では客先向けの文にならない | §A-3・判断 Q4 |
| Z6 | 説明文の長さ | Azure DevOps の PR 説明文は **4000 字まで**（Update API の仕様に明記）。Backlog 1 件の本文だけで 400 字を超える実例がある | §A-4 |

---

## 1. 全体像

```
aiw pr [--dry-run] [--check] [--task <archive のタスクディレクトリ>]
```

- **入力**: archive の 1 タスク分のディレクトリ（既定は**最新**の `archive/*/<日付時刻>-task/`）と、
  `runs/<Task ID>/screenshots/after-*.png`、Event Log（読むだけ・§A-2）。**`state.json` は読まない**
- **出力**: Azure DevOps の draft PR（作成 or 説明文の更新）と、Event Log の `pr.*` イベント
- **`--dry-run`**: API を一切呼ばない。説明文の全文・字数・実行予定の操作（作成 / 更新 / 添付の一覧）を表示して終わる。
  **Event Log にも書かない**（副作用ゼロ）
- **`--check`**（Stage 0）: 読み取り API だけで接続を確かめる（§2）

### モジュール配置

| ファイル | 責務 |
| --- | --- |
| `src/engine/pr/source.ts` | タスクディレクトリの解決と成果物の読み取り（**fs と Event Log だけ**。HTTP を知らない） |
| `src/engine/pr/describe.ts` | 説明文の組み立て（**純関数**。入力 = source の結果、出力 = 文字列 + 縮退の記録） |
| `src/engine/pr/azdo.ts` | REST クライアント（`fetchImpl` を引数で受ける = テストで差し替える） |
| `src/engine/pr/secret.ts` | `PatSecret`（`SessionSecret` と同じ規律の型）と `redactPat()` |
| `src/engine/pr/run.ts` | 手順の組み立て（作成 or 更新・添付・縮退・Event Log） |
| `src/cli.ts` | `aiw pr` の配線のみ |

**`src/engine/pr/` は `state.ts` / `engine.ts` / `completion.ts` を import しない**（test 58 と同じ import 検査で固定）。
これが「state に触らない」の機械的な強制になる。

---

## 2. Stage 0: 接続確認（読み取りのみ）

### 2-1. 設定

runtime の `config/workflow.yaml` に置く（**assets にはコメントの雛形だけ**。値は環境固有なので配らない・不変条件7）。

```yaml
settings:
  pr:
    organizationUrl: https://dev.azure.com/primalinc   # Services: dev.azure.com/<org> または <org>.visualstudio.com / Server: https://<host>/<collection>
    project: BizForecast for 東急建設
    repository: Template.toukyu
    # targetBranch: master        # 省略時はリポジトリの defaultBranch（GET repository の値）
    # apiVersion: "7.1"           # Services は省略可（7.1）。**Server は必須**（§2-3）
```

- `aiw pr --check` は settings が無ければ、checkRepoRoot の `git remote get-url origin` から 3 値を**導出して表示する**
  （`https://<user>@dev.azure.com/<org>/<project>/_git/<repo>` / `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` /
  `https://<org>.visualstudio.com/...` / Server の `https://<host>/<collection>/<project>/_git/<repo>`。
  URL エンコードは戻す。`<user>@` は捨てる）
- **aiw は workflow.yaml を書き換えない。** 導出値を YAML 断片として表示し、人間が確認して貼る
  （この環境の導出値は上の例のとおり: org `primalinc` / project `BizForecast for 東急建設` / repo `Template.toukyu`）

### 2-2. PAT

- **env `AZURE_DEVOPS_PAT` からのみ読む。** settings に PAT のキーは作らない（書けないようにするのが一番強い）。
  `settings.pr` に `pat` / `token` / `secret` / `password` / `credential` を含むキーがあれば、`aiw pr` は**キー名だけ**を示して止まる
  （値は表示しない。ローダーには足していない: 他のコマンドの読み込みを変えないため）
- 未設定なら次を表示して exit 1（スタックトレースなし）:
  - 発行: Azure DevOps → User settings → Personal access tokens → New Token。
    **Scopes は Custom defined → Code: Read & Write のみ**。有効期限は短く
  - 設定: Windows の「環境変数を編集」（GUI）でユーザー環境変数 `AZURE_DEVOPS_PAT` を作り、端末を開き直す。
    ⚠️ コマンドライン（`setx` / `$env:` / `export`）で値を打つとシェルの履歴に残るので案内しない
  - **PAT の値をチャット・ファイル・コミットに書かないこと**
- 認証は `Authorization: Basic base64(":" + PAT)`。**base64 の形も秘密として扱う**（漏えい検査の対象に含める）

### 2-3. Services / Server の差分

| | Services | Server |
| --- | --- | --- |
| 判定 | `organizationUrl` のホストが `dev.azure.com` / `*.visualstudio.com` | それ以外 |
| URL | `{organizationUrl}/{project}/_apis/git/repositories/{repo}/...` | 同形（`organizationUrl` がコレクションまで含む） |
| api-version | 既定 `7.1`（attachments も 7.1 で GA） | **`settings.pr.apiVersion` 必須。推測しない**。目安: 2020 = `6.0` / 2022 = `7.0` / 2022.1 以降 = `7.1` |
| 認証 | PAT（Basic） | 同じ |
| 既知の差 | 不正な PAT に **203 + HTML（サインインページ）** を返すことがある | 自己署名証明書は v1 対象外（Node の CA 設定は人間の環境側） |

`isDraft` は Server 5.0 のドキュメントから存在する。Server で draft が効かない版だった場合は、
**作成結果の `isDraft !== true` を検知して report**（下書きにならなかったことを黙らない）。

### 2-4. `--check` が呼ぶもの（すべて GET）

1. `GET .../git/repositories/{repo}` → 200 で `id` / `defaultBranch` / `webUrl` を表示
2. `GET .../git/repositories/{repo}/pullrequests?searchCriteria.status=active&$top=1` → 200 を確認（件数だけ表示。中身は出さない）

**書き込みの probe はしない。** 初回の実 PR は、人間が同席する実タスクで `--dry-run` → 本実行の 2 段で作る。

---

## A. 説明文のテンプレート

### A-1. 構成（日本語・客先レビュアー向け）

```markdown
## 概要
<概要文（§A-3）>

## 変更したファイル（このブランチの変更・n 件）
- `Primal.Template.Web.Front/.../EditableGridCore.tsx`
- ...（最大 30 件。超えたら「ほか n 件」。出所は §A-2b）
事前に宣言した変更範囲と実際の差分の突き合わせ: <検査済み・宣言外の変更なし | 検査済み・宣言外の変更あり（n 回の検査で検出） | 検査は実行されていない | 検査の記録なし>

## 確認結果
受け入れ条件: 確認済み n / 不合格 n / 未確認 n（全 n 件）
手動での確認が必要な項目（n 件）:
- <Manual Verification Required の各項目の 1 行目>

## レビュー
重大な指摘 n 件 / 主要な指摘 n 件（レビュー時点）
- 修正: <修正ステップを n 回実施し、修正後の確認を通過 | 修正なし（指摘なし）>
- 今回は対応せず別途対応とした事項（n 件）:
  - <Backlog 各項目の Summary の 1 文目>

## 画面
![<画面名>](<添付 URL>)
...（添付できなかった場合は §B の縮退文）

---
この説明文はタスクの記録から自動生成しました（生成キー: <sha256 先頭 12 桁>）。
```

### A-2. 各節の出所（**読むのは成果物と Event Log だけ**）

| 節 | 出所（タスクディレクトリ内） | 欠けたとき（**偽装しない**） |
| --- | --- | --- |
| 概要 | `task-metadata.json` の `summary`（§A-3 の処理） | 「タスクの要約の記録なし」 |
| 変更ファイル | **ブランチの差分**（2026-10-23 改訂・下記 A-2b）。git の読み取りだけで取る | 取れなければ「このブランチの変更ファイルを取得できなかった」 |
| （突き合わせ用・説明文には出さない） | `context-package.md` の `## Modify`（無い古い archive は `current-result.md` の `## Files Changed`） | 無ければ突き合わせを省き、その旨を stdout に出す |
| 突き合わせの 1 行 | Event Log の、このタスクの窓（下記）にある `validation.completed` の `diff-scope` の status | 「検査の記録なし」。**passed が 1 件も無いのに「済み」と書かない** |
| 受け入れ条件 | `current-result.md` の `## Acceptance Criteria Verification` を `countTriStatus`（既存）で集計。`unrecognized` が 1 以上なら「判定不明 n」を足す | 「確認結果の記録なし」 |
| 手動確認 | `current-result.md` の `## Manual Verification Required` の箇条書き（`countListItems` と同じ規則） | 節が無い = 「記録なし」、0 件 = 「なし」（**null と 0 を区別**・summary.ts と同じ） |
| レビュー件数 | `current-review.md` の `## Critical` / `## Major` 配下の `###` 見出し数（無ければ箇条書き数） | `current-review.md` が無い / テンプレートと同一 → 「**レビュー記録なし**」 |
| 修正の回数と通過 | Event Log の窓の `step.completed`（`step: fix` の件数）と、窓の最後の `transition`（`from: improve-check` → `to: reflection`） | 「修正の記録なし」 |
| 別途対応 | `current-review.md` の `## Backlog` の `### BL-*` ごとの `Summary:` 行の 1 文目（ID は出さない・§A-3） | 0 件なら行ごと省く。節が無ければ「記録なし」 |
| 画面 | `runs/<Task ID>/screenshots/after-*.png`（Task ID は `current-task.md` の `- Task ID:` 行） | 0 枚なら節ごと省く（撮っていないことは判定に使わない・§C） |

### A-2b. 変更ファイルはブランチの差分から（2026-10-23 改訂・人間の判断）

初回の `--dry-run`（FEAT-review-feedback-1022）で、宣言（`## Modify`）の 4 件のうち 3 件が**親リポで ignore されている e2e**だった
（PR に入らないファイルが客先向けの説明文に並ぶ）。また feature = ブランチなので、ブランチの差分（17 件）は最新タスクの宣言と範囲が違う。

- 説明文の「変更したファイル」= `git diff --name-only $(git merge-base origin/<対象> origin/<ブランチ>) origin/<ブランチ>`
  （push 済みの追跡ブランチ = PR の画面に出る差分と同じ集合。API を呼ばないので `--dry-run` でも出る）。
  見出しは「このブランチの変更」とし、他の節（最新タスクの記録）と範囲が違うことを示す
- 追跡ブランチが無ければローカルの `HEAD` と比べ、その旨を stdout に出す。対象ブランチは本実行では API の値、
  `--dry-run` では `settings.pr.targetBranch` → `origin/HEAD` の順
- archive の宣言は**突き合わせだけ**に使う。宣言にあってブランチの差分に無いファイルは、理由（ignore 対象 / 差分に無い）つきで
  **stdout にだけ**出す（説明文には書かない・黙って落とさない）

**タスクの窓（Event Log）**: archive ディレクトリ名の日付時刻 T（`archiveArtifacts` が付けた UTC）に対し、
「T 以降で最初の `transition`（`from: reflection`）」を終端、「それより前で直近の同種 transition」を始端とする。
`currentTaskWindow` と同じ境界の定義を**終端つき**にしたもの（境界の定義を増やさないため `observed.ts` に関数として足す）。
Event Log が無い・読めない場合は三値（missing / unreadable）をそのまま「記録なし」として説明文に出す。

### A-3. 内部用語の方針（推奨: 出さない・訳語に寄せる）

| 区分 | 扱い |
| --- | --- |
| aiw / ステップ名（research・implementation・review・fix・improve-check・reflection） | 出さない。必要な所は「調査」「実装」「コードレビュー」「修正」「修正後の確認」 |
| validator 名（diff-scope 等） | 出さない。「事前に宣言した変更範囲と実際の差分の突き合わせ」 |
| 三値 | PASS → 確認済み / FAIL → 不合格 / NOT VERIFIED → 未確認 |
| Critical / Major / Backlog | 重大な指摘 / 主要な指摘 / 今回は対応せず別途対応とした事項 |
| ID（`BL-\d+` / `AC-\d+` / `OD-\d+` / `R\d+` / `TASK-...` / `FEAT-...`） | 機械的に除去（括弧ごと: `（BL-346）` → 空）。**定型語の置換表は `describe.ts` の 1 箇所**に持つ |
| 自由記述（summary・手動確認・Backlog の Summary） | **ID の除去と置換表だけ**。言い換えはしない（機械が意味を変えないため） |

2026-10-23 追記（初回の `--dry-run` から）:
- `BL-344 ×2` のような「ID と件数」は ID だけ除くと `×2` が浮くので、**`既知の課題（2 件）`** へ置き換える
- Backlog の `Summary:` は複数行にわたるので、続く行（次の `- 項目:` まで）を含めて 1 文目を取る
- 契約番号・取引先名などの**実データらしい語**（6 桁以上の数字・英字 + 6 桁以上の数字・会社名の語尾）は消さない
  （消すと意味が変わる）。`--dry-run` と本実行の stdout に候補を並べて警告し、公開前に人が判断する

⚠️ **自由記述は機械処理では客先向けの文にならない**（Z5）。v1 では次の 2 つで受ける:

1. **draft で止まる** = 人間が公開前に説明文を直す（公開ボタン = 署名、の確定方針と同じ場所）
2. `--dry-run` の出力に「内部用語の残り」を数えて出す（ID 除去後に残った英字の連続・`spec` / `e2e` / `.tsx` 等の件数）。
   **数タスク測って**、毎回人間が書き直しているなら v2 で reflection に客先向けの要約欄を足す（Q4）

### A-6. 説明文は「対応した内容」と「画面（変更前 → 変更後）」の 2 節だけ（2026-10-23 改訂・人間の判断）

初回の `--dry-run` を見た人間の判断:「説明文がわかりにくすぎる。何を変更したかと、その変更点の before / after のスクショだけあればいい」。
A-1 のテンプレート（概要・変更ファイル・確認結果・レビュー）は**この節で置き換える**。

- **対応した内容** = 依頼文（`user-task.md`。feature では feature 全体の依頼）の**チェックボックスの項目**を、見出し（`###` 以下を
  「 / 」でつないだ画面 / タブ）ごとに、**全文**を ID 除去と定型語の置換だけして並べる。子項目（箇条書き・番号付き）はそのまま下に。
  チェックボックスでない箇条書き（進め方・完了条件）は拾わない（実物の依頼文で、要求はチェックボックス・進め方は普通の箇条書きだった）。
  チェックボックスが無い依頼文では「対応した内容（作業記録の要約）」として task-metadata の summary で代え、stdout で知らせる
- **画面** = `runs/<Task ID>/screenshots/` の `before-<名前>.png` と `after-<名前>.png` を名前で対にした表（画面 / 変更前 / 変更後）。
  feature の全タスク（このタスクまで）から集め、変更前は**最初に撮ったもの**、変更後は**最後に撮ったもの**（PR 全体の変更前 → 変更後）。
  片方しか無い画面は「（なし）」、添付できなかった画像は保存先を書く。対になっていない画面は `--dry-run` で知らせる
- 以前の節（概要・変更ファイル・宣言との突き合わせ・確認結果・レビュー・別途対応）は**説明文から外し、`--dry-run` の
  「内部の確認結果」として stdout にだけ出す**（人間には見えたまま・黙って捨てない）。本実行では宣言との突き合わせだけ stderr に出す
- スクショを撮るのは **implementation（変更前・変更後）と fix（画面を変えたら変更後を撮り直す）**。§C の review の案 (a) は取り下げ
  （review は spec を書けず変更前を撮れない・BL-373 の実測）

### A-4. 長さ（4000 字）

- 予算は**生成キーの行を含めて 4000 字**。超えたら次の順で削る（各段で再計測）:
  1. 別途対応の各項目を 60 字で切る → 2. 手動確認の各項目を 80 字で切る → 3. 変更ファイルを 15 件に →
  4. 概要を 600 字で切る → 5. 別途対応・手動確認を 5 件に
- 削ったら該当節の末尾に「（以下省略。全文はタスクの記録を参照）」。**黙って切らない**
- それでも超えたら PR を作らず失敗（report）。`--dry-run` は全段の字数を表示する

### A-5. タイトル

- 作成時のみ: `featureName`（無ければ `taskName`）。**更新ではタイトルに触らない**（人間が直している可能性）

---

## B. スクショの添付

### B-1. 仕様（確認済み・Microsoft Learn の REST リファレンス 7.1）

- `POST .../pullRequests/{id}/attachments/{fileName}?api-version=7.1`、本文 `application/octet-stream`、
  スコープ `vso.code_write`（= Code Read & Write で足りる）。応答 `Attachment.url` が本文から参照できる URL
- 添付は PR の ID が要るので、**作成 → 添付 → 説明文の PATCH** の順になる

### B-2. 手順と冪等性

1. 添付名は `after-<元の名前>.<sha1 先頭 8 桁>.png`（内容が同じなら同じ名前）
2. 更新時は先に `GET .../attachments` で一覧を取り、同名があれば再アップロードせずその URL を使う
3. 1 枚 5MB 超・合計 10 枚超は添付しない（縮退の扱い）

### B-3. 縮退（report）

添付 API が失敗した（非 2xx・タイムアウト・上限超過）画像は、`## 画面` に
「画面の記録はタスクの作業フォルダに保存しています: `.ai-workflow/runs/<Task ID>/screenshots/after-xxx.png`」
と書き、**PR 自体は作る**。stdout と Event Log（`pr.attachment-failed`）に件数と理由を残す。
⚠️ ローカルパスは客先から見えないので、**縮退した説明文は公開前に人間が扱いを決める**旨を stdout に出す。

### B-4. 公開前の確認（人間）

stdout の最後に必ず出す: 「公開前に確認: (1) 画面に実データ・実名が映っていないか (2) 説明文の内部用語」。
説明文（客先向け）にはこの注意を書かない。

---

## C. review Skill への追記（同枠・別コミット）

> ⚠️ **2026-10-23 に取り下げ。** 撮影は implementation / fix へ移した（§A-6）。以下は当時の判断の記録として残す。
> 版: review 9 → 10（撮影の項目を「撮らない」へ）・implementation 8 → 9・fix 8 → 9。

### C-1. 実現性の問題（Z4）

依頼文の 1 項目（「E2E で検証した画面の after スクショを `runs/<task>/screenshots/` に保存する」）は、
**今の review の権限では、spec が env で出力先を受ける画面しか撮れない**。
spec を書くことは禁止（Reviewer が Builder になる経路を塞ぐ・ツール制限でも構造的に不可能）なので、
撮れない画面のほうが多い。

### C-2. 案（Q2）

| 案 | 中身 | 長所 | 短所 |
| --- | --- | --- | --- |
| **(a) 推奨** | Skill の 1 項目は「**E2E を当てた spec がスクショの出力先を env で受ける場合に限り**、その env を `runs/<Task ID>/screenshots/` に向け、ファイル名を `after-` で始めて走らせる。受けない spec のためにスクショを撮る手段を作らない（撮れなければ撮らない）」。判定に使わない・撮影失敗を NOT VERIFIED にしない、を同じ項目に書く | 権限・禁止事項を変えない。今日から効く | 撮れる画面は限られる（実測で何割撮れるかを数える） |
| (b) | 製品側に共通の仕組み（例: playwright.config が `AIW_AFTER_SHOTS_DIR` を見て、各 test の最後の画面を `after-<spec>-<test>.png` で書く小さな reporter）を**製品のタスクとして** codex に作らせる。review はその env を付けて走らせるだけ | 全画面で撮れる | 客先リポへのテスト基盤の変更（別タスク・要承認）。env を付けた実行が `./tools/nrun.cmd:*` の許可に当たるかの実測が要る |
| (c) | review の Bash 許可に `cp:*` 等を足して test-results から拾わせる | 実装が小さい | **「書き込みは許さない」の第1網に穴を開ける**（Edit のパス制限を迂回できる）。採らない |

(a) で始め、`--dry-run` の「画面 n 枚」を数タスク数えて、少なければ (b) を別タスクとして起票する。

### C-3. 付随する作業

- `skills.review` 8 → 9（assets と runtime）・分類表（`docs/m2-prompt-decomposition.md` の review 節に 1 行・「新規追加」）
- **新しい成果物チェックリスト**（`runs/<Task ID>/screenshots/`）: 生成 = review / contract = 判定に使わないので定義しない /
  archive = 対象外（`runs/<Task ID>/` は archive されず runs/ に残る既存の扱い）/ 掃除 = しない（同上）/
  許可リスト = 変えない（(a) は既存の実行だけ）/ パス規約 = runtimeRoot 相対 / 2周目 = 名前に Task ID を含むので上書きしない
- baseline（`docs/baseline.md`）に世代注記: review Skill v9 と `aiw pr` の開始。観測項目 = 撮れた枚数 / 説明文の人の書き直し量

---

## D. 起動タイミング

- **v1**: 人間が手で `aiw pr`（reflection の承認後。`--dry-run` → 本実行）
- **v2 判定（実測後）**: reflection の postAction 化 or `aiw auto` の終端への接続。判定材料は
  (1) `--dry-run` の後に人間が説明文をどれだけ直したか (2) 失敗の内訳 (3) 添付の縮退率。
  postAction にする場合も**失敗は report**（halt にしない・タスクの完了を妨げない）で、
  `pendingTransition` の冪等チェックポイントに乗せる（不変条件3）。**v1 では作らない**

---

## E. ブランチの前提（Z3）

### E-1. v1 の扱い

- 冪等キー = **checkRepoRoot の現在のブランチ**（`git rev-parse --abbrev-ref HEAD`。読むだけ）
- 次の場合は**作らずに終了**（exit 1・理由と手順を表示）:
  - 現在のブランチ = 対象ブランチ（`master` のまま = 今の運用）→ 「タスク用のブランチを作って push してから」
  - detached HEAD
  - 同名のブランチがリモートに無い（`GET .../refs?filter=heads/<branch>`・読み取り）→ 「`git push -u origin <branch>` してから」
- ローカルにリモートより先のコミットがあれば（`git rev-list --count @{u}..HEAD`）**警告して続行**（説明文は成果物から作るので、差分の内容とは独立）
- **aiw は push もブランチ作成もしない**（git への書き込みは人間）
- 同じソース・対象の active PR を検索し:
  - 0 件 → 作成（`isDraft: true`）
  - 1 件・draft → 説明文を更新（下記の上書き保護つき）
  - 1 件・**公開済み（`isDraft: false`）→ 触らない**（人間が署名した後の提出物を機械が書き換えない）。report で終了
  - 2 件以上 → 触らない。report で終了

### E-2. 上書き保護（更新時）

説明文の末尾の「生成キー」= **生成キー行を除いた本文の sha256**。更新前に PR の現在の説明文
（`GET .../pullrequests/{id}`。一覧は 400 字で切れるので使わない）から生成キーを読み、本文を計算し直して:

- 一致 → 人の手が入っていない → 上書きしてよい
- 不一致 / 生成キーが無い → **人が直した** → 上書きしない（report）。`--dry-run` で新しい説明文を見て、人間が手で反映する

（Azure DevOps が説明文を正規化して一致しなくなる場合も「上書きしない」側に倒れる＝安全側。初回の実 PR で実測する）

### E-3. PR の単位（Q1）

今の運用は「feature を master へ直接コミット」で、タスク（= feature の 1 フェーズ）単位のブランチが無い。

| 案 | 単位 | 説明文 |
| --- | --- | --- |
| **(i) 推奨** | **feature = ブランチ = PR**。フェーズごとに `aiw pr` を走らせ、同じ PR の説明文を**最新フェーズの成果物で**更新する | v1 の説明文は 1 タスク分（最新のフェーズ）。feature 全体の集約（archive の feature フォルダの全タスク）は v2 |
| (ii) | タスク = ブランチ = PR | 1 タスク分がそのまま合う。ただし feature 8 フェーズなら PR 8 本になり、客先レビュアーの負担が大きい |

(i) でも (ii) でも v1 のコードは同じ（冪等キーがブランチなので）。違うのは**人間のブランチの切り方**だけ。

### E-5. 説明文の元にするタスクの記録はブランチで選ぶ（2026-10-23 改訂・人間の判断）

v1 は「archive の一番新しいタスク」を使っていたので、別の feature のブランチで打つと別の feature の記録で PR を作った
（実例: `feature/review-feedback-1023` で 1022 の記録）。`--task` が無いときは次で選ぶ:

- ブランチ名から `feature/`（`feat/` `task/` も）を除いた名前を、archive の feature フォルダの feature ID（日付時刻と `FEAT-` を除く。
  日付なしの旧形式も同じ）と照らし、一致した feature の一番新しいタスク。単一タスク（`archive/single/`）は Task ID（`TASK-` を除く）と照らす
- 一致しなければ **PR を作らずに止まる**（`--dry-run` も同じ・API は呼ばない・`pr.skipped` の reason は `no-task-record-for-branch`）。
  黙って別の記録を使わない
- 対象ブランチの上で打ったときは、記録を探す前に「対象ブランチと同じ」で止まる（git の読み取りで分かる範囲: `settings.pr.targetBranch` → `origin/HEAD`）
- `--task` が明示されていればそれを使い、ブランチと名前が合わなければ警告だけ出す
- 前提: **ブランチ名は feature ID から付ける**（`FEAT-x` → `feature/x`）

### E-4. 「タスク開始時のブランチ作成を postAction にする」案（実装は要承認・v1 では作らない）

- task-planning の承認（ゲート①）後の postAction `createTaskBranch`: feature の最初のフェーズなら `aiw/<featureId>` を
  checkRepoRoot で `git switch -c`。既にあれば switch のみ（冪等）。作業ツリーが汚れていれば**何もしないで report**
- ⚠️ これは **aiw が初めて git に書く経路**になる。diff-scope の baseline（`captureIfAbsent`）より前に走らせる必要があり、
  switch で作業ツリーが変わると baseline の意味が変わる。設計を別に起こす価値がある（本書の範囲外）

---

## F. 安全網

### F-1. PAT の規律（`SessionSecret` と同じ）

- `PatSecret` 型: 値は `reveal()` でしか取り出せず、`toString` / `toJSON` / `util.inspect` は `[REDACTED]` を返す
- `reveal()` を呼ぶのは `azdo.ts` の Authorization ヘッダ組み立て 1 箇所だけ（import 検査で固定）
- 出力の最終段（stdout / stderr / Event Log へ書く文字列）を `redactPat()` に通す（PAT と base64 形の両方）
- HTTP エラーは **status と応答 JSON の `message` を 200 字まで**（redact 後）。応答本文の全文・リクエストヘッダは出さない

### F-2. Event Log

| event | いつ | 主なフィールド（**PAT・説明文の本文は載せない**） |
| --- | --- | --- |
| `pr.checked` | `--check` の成功 / 失敗 | `ok`, `status`（HTTP） |
| `pr.created` / `pr.updated` | 作成・更新 | `prId`, `sourceBranch`, `targetBranch`, `taskDir`, `descriptionChars`, `generationKey`, `isDraft` |
| `pr.skipped` | 公開済み・人が直した・複数・ブランチ不成立 | `reason` |
| `pr.attachment-failed` | 添付の縮退 | `count`, `reasons` |
| `pr.failed` | 作成 / 更新の失敗 | `stage`, `status`, `message`（redact 済み） |

- `--dry-run` は書かない
- `pr.*` は reflection の後に書かれるので、次のタスクの窓に入る。`observed.ts` の `eventsInWindow` からは `pr.*` を除く
  （「このタスクはまだイベントを出していない」の表示が `aiw pr` で崩れないため。**表示だけの変更**・不変条件1）

### F-3. exit code

| 結果 | exit |
| --- | --- |
| 作成 / 更新（添付の縮退を含む）・`--dry-run`・`--check` 成功 | 0 |
| 設定不足（PAT・settings）・ブランチ不成立・API 失敗・字数超過・skipped | 1 |

どれも `state.json` に触らないので、タスクの完了・次タスクの開始を妨げない。

---

## G. 故障注入（完了条件・テスト番号は 260〜）

| # | 注入 | 期待 |
| --- | --- | --- |
| 260 | `AZURE_DEVOPS_PAT` 未設定 | 案内（発行手順・GUI での設定）を表示して exit 1。`Error:` のスタックトレースが出ない |
| 261 | PAT = 乱数の文字列。偽 fetch が全応答の本文に Authorization ヘッダと PAT を埋めて 500 を返す | stdout / stderr / execution-log.jsonl のどこにも PAT・`base64(":"+PAT)` が無い（**grep 固定**） |
| 262 | 既存の draft PR（生成キー一致）あり | POST pullrequests が 0 回・PATCH が 1 回。タイトルは送らない |
| 262b | 既存 PR が公開済み / 生成キー不一致 | PATCH 0 回・`pr.skipped` |
| 263 | 添付 API が 500 | PR は作られ（POST 1 回）、説明文にパスの縮退文、exit 0、`pr.attachment-failed` |
| 264 | `--dry-run` | fetch の呼び出し 0 回・Event Log の行数不変・説明文と操作予定を表示 |
| 265 | `current-review.md` 無し / テンプレートのまま、`context-package.md` 無し、Event Log 無し | 説明文に「レビュー記録なし」「事前宣言の記録なし」「検査の記録なし」。**0 件・確認済みと書かない** |
| 266 | 4000 字を超える成果物 | 段階的に削り「以下省略」付きで 4000 字以内。削っても超えるなら作らない |
| 267 | `src/engine/pr/` が `state.ts` 等を import していない・`reveal()` の呼び出しが 1 箇所 | import 検査 |
| 268 | `aiw pr` の前後で `state.json` のバイト列が同一 | 作成・更新・失敗の全経路 |
| 269 | 現在のブランチ = 対象ブランチ / リモートにブランチ無し | API の書き込み 0 回・手順を表示して exit 1 |

実装メモ（2026-10-20）: 268 は独立のテストにせず、262 / 262b / 263 / 264 の各経路の中で `state.json` のバイト列を比べている。
土台の単体として 270（remote からの導出）/ 271（表形式の三値集計）/ 272（終わったタスクの窓）/ 273（内部用語の除去）/
274（`context-package.md` の archive と、次の research が記録を上書きしないこと）/ 275（実際の reflection の archive と Event Log から dry-run まで）を足した。

実装で分かったこと: 実物の `## Acceptance Criteria Verification` は**表**で書かれていて、既存の `countTriStatus`（`Status:` 行だけ）は 0 件と数える。
`aiw status --summary` も同じ盲点を持つ（AC の三値が全部 0 に見える）。pr は表も読む `countTriStatusAny` を使い、summary 側は backlog へ。

---

## H. 進め方（承認後）

1. **engine**（コミット 1）: `src/engine/pr/*`・`aiw pr`・observed の窓関数・テスト 260〜269・（Q3 が「退避する」なら `archiveArtifacts` に `context-package.md`）
2. **review Skill**（コミット 2）: Q2 の案で 1 項目・`skills.review` 9・assets と runtime
3. **記録**（コミット 3）: 分類表・新しい成果物チェックリストの「通した記録」・backlog・README の `aiw pr` 節・runtime の baseline 世代注記（runtime は git 外）
4. 段階ごとに `npm run build` と全テスト。push して ahead 0
5. Stage 0: 人間が PAT を設定 → `aiw pr --check` → settings を貼る
6. 初回の実 PR: 実タスクで `--dry-run` を人間が読む → 本実行 → 生成キーの往復を実測（§E-2）

## やらないこと（v1）

draft 解除・マージ・レビュアー指定 / work item 連携 / 客先リポへの書き込み probe /
aiw による push・ブランチ作成 / feature 全タスクの集約 / 説明文の言い換え（LLM）

before スクショは 2026-10-23 に v1 へ入れた（§A-6・人間の判断）。
