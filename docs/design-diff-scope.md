# diff-scope validator 設計（M1.5 第2部）

**状態: 承認済み・実装済み**（M1.5 第2部、コミット `9d3cc25` / `122594e` / `7ae2ab6`）。

実装との差異が生じた箇所は本文書を正本として更新する。実装時に判断した未記述事項:

- rename は新旧**両方**のパスを違反候補にする（宣言外を宣言済みの名前へ改名して
  すり抜ける経路を塞ぐ）
- 欠損時の分岐は step 名ではなく `onViolation` から導く（課題4）
- `scope-violation-report.md` は違反が解消したら**削除する**（古いレポートが残ると
  review が解決済みの違反を現在のものとして読む）
- 「検査対象に変更が1件も無い」場合は「違反なし」と**別の文面**にする
  （`no changes observed ... verify repoRoot if unexpected`）。KI-06 参照

diff-scope は「宣言されたファイル以外が変更されていないか」を検査する安全網。
設計の最優先事項は halt できることではなく、**偽陽性を出さないこと**。
親リポジトリには常時タスクと無関係な未コミット変更が多数あり、
HEAD と単純比較する実装では「常に違反を出す validator」になって無効化される。

---

# 調査結果（実測）

すべて 2026-08-05 に本環境で実測した。

## 1. resolveRoot() の現状

`src/engine/paths.ts:46-71`。解決順は:

1. 明示引数（CLI `--root`）
2. **環境変数 `AIW_ROOT`**（既に実装済み）
3. cwd から上位へ探索。各階層で `<dir>/.ai-workflow2/config/workflow.yaml`
   または `<dir>/config/workflow.yaml` を探す
4. 見つからなければ `<cwd>/.ai-workflow2` へフォールバック

つまり resolveRoot() が返すのは**ランタイムルート（.ai-workflow2 の場所）だけ**であり、
「検査対象リポジトリのルート」という概念はエンジンのどこにも存在しない。
前回レビューの指摘どおり、diff-scope が初めてその概念を持ち込む。

なお「AIW_ROOT 対応」自体は既に resolveRoot() に入っている。本設計で新たに要るのは
AIW_ROOT ではなく、**それと混同しないもう1つのルート（検査対象リポジトリ）**の導入である。

## 2. 親リポジトリの git status --porcelain

| 集計 | 件数 |
| --- | ---: |
| 表示行数（ディレクトリ集約あり） | 29 |
| `-uall`（ファイル単位）合計 | **32** |
| tracked modified（` M`、unstaged） | 10 |
| untracked（`??`） | 22 |
| staged | 0 |

untracked 22 件はタスクと無関係な作業中コンポーネント群
（`adminUser/` `login/` ほか）と `.claude/` `AGENTS.md` 等。
**「タスク開始前から dirty が多数」は仮定ではなく現在の実態**である。

## 3. .ai-workflow2 の扱い

- 親の `.gitignore:349` に `/.ai-workflow2/` があり **ignore されている**
- `git ls-files .ai-workflow2` は 0 件（追跡なし）
- 独立リポジトリでもない: `.ai-workflow2/` 内で `git rev-parse --show-toplevel`
  → `<client-repo>`（親）

したがって **.ai-workflow2 配下の変更は親の git status に一切現れない**。
Codex が current-result.md 等を書いても diff には出ない（検査対象外として正しい挙動が
git 側で無料で手に入る）。

## 4. tools/aiw の扱い

- 親の `.gitignore:380` に `/tools/aiw/` があり **ignore されている**（追跡 0 件）
- かつ**独立 git リポジトリ**（HEAD は `ba2ad72`、working tree clean）

つまり親リポジトリで git diff / status を取っても tools/aiw の変更は**不可視**。
「タスクが aiw 自身を変更する場合」（現在まさにそう）、親ルートで動く diff-scope は
その変更を観測できない。

## 5. git rev-parse --show-toplevel

| 実行場所 | 結果 |
| --- | --- |
| `.ai-workflow2/` | `<client-repo>`（親） |
| `tools/aiw/` | `<client-repo>/tools/aiw`（自身） |

`--show-toplevel` は「最も近い囲みリポジトリ」を返す。.ai-workflow2 は親の中にあるので、
**ランタイムルートの親ディレクトリから引けば検査対象リポジトリが得られる**（既定値として使える）。

## 追加実測・所見

- `git stash create` は親リポで成功し dangling commit SHA を返した。ただし
  **untracked を含まない**（含めるには `stash push -u` が必要で、作業ツリーを変更してしまう）。
  実行時に CRLF 変換警告が 8 件出た（autocrlf 環境）。
- **`.ai-workflow2/templates/context-package.md` は存在しない**（templates/ にあるのは
  current-* と research-findings, user-task のみ）。宣言源は research が生成する
  成果物 `context-package.md` の実物であり、`# Files` / `## Modify` の構造は
  workflow.yaml の artifact contract（`artifacts.context-package`）が halt 付きで保証している。
- 宣言の実書式（現 runtime の実物より）:
  `` - `Primal.Template.Web.Front/ClientApp/tests/e2e/execution-budget-lock.spec.ts`（`:49-50`） ``
  ——**list item + インラインコード + 括弧の付記**が実態。パーサはこれを前提にする。
- `state.json` の `featureId` / `taskId` は現在も null（KI-02 で判明済み。run 単位の ID は未実装）。

---

# 設計課題ごとの選択肢

## 課題1: リポジトリルートの特定

### 概念の分離

2つのルートは別物として扱い、別の名前を与える。

| 概念 | 内容 | 解決手段 |
| --- | --- | --- |
| **runtimeRoot** | `.ai-workflow2` の場所。state / config / artifacts | 既存 `resolveRoot()`（--root → AIW_ROOT → 上位探索） |
| **checkRepoRoot** | diff-scope が git コマンドを実行するリポジトリ | 本設計で新設 |

### checkRepoRoot の解決順（提案）

1. `workflow.yaml` の `settings.repoRoot`（明示指定。絶対パス、または runtimeRoot からの相対）
2. 既定値: `git -C <dirname(runtimeRoot)> rev-parse --show-toplevel`

環境変数（AIW_REPO_ROOT 等）や CLI フラグは**増やさない**。理由:

- 検査対象は「このワークフローが何を扱うか」というワークフローの属性であり、
  呼び出しごとに変わる値ではない。設定の正本は workflow.yaml（既存の流儀と一致）
- AIW_ROOT と紛らわしい変数を増やすと、まさに今回分離した2概念が再び混ざる
- 環境変数で検査対象をすり替えられる余地は、安全網としてはむしろ弱点

### エンジンを客先リポジトリの外へ移した場合

エンジン（tools/aiw）の場所は checkRepoRoot の解決に一切関与しない
（起点は runtimeRoot の親）。したがってエンジンをどこへ動かしても挙動は変わらない。
将来 runtimeRoot 自体を検査対象リポジトリの外へ出す場合は、
その時点で `settings.repoRoot` の明示指定が必須になる——既定値解決に失敗した場合の挙動は
課題4（欠損時 skipped/failed）に従い、黙って通ることはない。

### ネストしたリポジトリ（tools/aiw）

**v1 は「1タスク = 1検査リポジトリ」とし、横断検査は扱わない。**

- 通常タスク（アプリ改修）: 既定値で親リポジトリが対象。tools/aiw は ignore 済み +
  独立リポなので自然に不可視（誤検出しない）
- aiw 自身を変更するタスク: `settings.repoRoot: tools/aiw` を明示して aiw リポを検査する
- **制約として明記**: 親と aiw の両方に触るタスクでは片方しか検査できない。
  その場合 diff-scope はもう片方に対して盲目であり、これは v1 の既知の限界とする
  （検査できない側を「検査した」とは報告しない。violation report に checkRepoRoot を必ず記載する）

## 課題2: baseline の記録

### 何を記録するか

| 案 | untracked 捕捉 | 人間の並行変更 | タスク中コミット | commit 消失(rebase) | サイズ | 複雑さ |
| --- | --- | --- | --- | --- | --- | --- |
| (a) HEAD SHA + dirty ファイル一覧 | ○（一覧に含める） | 検出はするが判別不能 | SHA 比較で検知可 | SHA は参考情報なので影響小 | 小 | 低 |
| (b) `git stash create` の dangling commit | **×（致命的）** | 内容比較可 | 検知可 | **gc で消える**（reflog に乗らない） | 小 | 中 |
| (c) dirty ファイルの内容ハッシュ一覧 | ○ | 検出はするが判別不能 | 影響なし（作業ツリー基準） | 影響なし | 小〜中 | 中 |
| **(d) = (a)+(c)** | ○ | 同上 | 検知可 | 影響小 | 小〜中 | 中 |

**(b) は却下。** Codex の逸脱で最も起きやすい「宣言外の新規ファイル作成」を原理的に
捕捉できず（stash create は tracked のみ）、dangling commit は `git gc` の prune 対象で
日を跨ぐタスクでは baseline 自体が消えうる。実測でも CRLF 警告を出しながら
tracked 変更全ファイルを読む重い操作だった。

**(c) 単独では HEAD 移動の検知ができず、(a) 単独ではシナリオ7
（既 dirty ファイルへの追加編集）を検出できない。** よって **(d) を採用する**:

```json
// runs/baseline.json（案）
{
  "version": 1,
  "capturedFor": { "step": "implementation", "fixAttempts": 0 },
  "capturedAt": "2026-08-05T02:30:00Z",
  "checkRepoRoot": "<client-repo>",
  "headSha": "1a814304...",
  "dirty": [
    { "path": "Primal.Template.Web.Front/ClientApp/package.json", "state": " M", "sha256": "..." }
  ]
}
```

- `dirty` は `git status --porcelain -uall` の全行（rename は両パスを保持）
- `sha256` は作業ツリーのバイト列のハッシュ（削除済みは null）。現リポ実測 32 ファイルで
  数 KB・数十 ms の規模
- `headSha` は「タスク中にコミットが発生したか」の検知**専用**。判定本体は
  dirty 集合とハッシュで行うため、rebase で commit が消えても検査は劣化しない

### 判定ロジック

検証時（`aiw run implementation` / `aiw run fix`）に現在の dirty 集合を取り直し:

```text
changedDuringStep =
    (現在 dirty − baseline dirty)                        … 新規に汚れたファイル
  ∪ { f ∈ 両方に存在 | hash(f) ≠ baselineHash(f) }       … さらに編集されたファイル

violations = changedDuringStep − declaredFiles − excludePatterns
```

baseline にあって現在 dirty にないファイルは「元に戻された or コミットされた」であり
違反ではない（後者は HEAD 移動警告で補足する）。

### いつ記録するか

| 案 | 問題 |
| --- | --- |
| new-task 時 | task-planning / research / 承認待ちの間の人間の作業がすべて「タスク中の変更」に混入する。最悪 |
| research 完了時（承認前） | 承認往復が日を跨ぐと同上 |
| **implementation 入場確定時**（承認後・遷移確定時） | 混入窓が最小。採用 |

**fix ループでは再取得するか** —— ここは本設計の分岐点なので明示する。

タスク開始時の1点固定にすると、fix の diff-scope（宣言源: current-review.md の
Files To Modify）は **implementation が正当に変更したファイルまで「fix 宣言外」として
違反にする**。implementation の Modify 宣言と fix の Files To Modify は一般に一致しない
（fix は部分集合を直す）ため、これは**構造的な偽陽性**であり、fix は halt なので
毎回止まる。1点固定は成立しない。

対策は2つ:

| 案 | 内容 | トレードオフ |
| --- | --- | --- |
| **A. per-step baseline（推奨）** | diff-scope を宣言する step への遷移確定時に毎回 capture（implementation 入場時、fix 入場ごと） | fix の検査が「fix 宣言のみ」で厳密に閉じる（Bounded Fixes と一致）。implementation で report 済みの違反は fix の baseline に吸収されるが、それは scope-violation-report.md として review に渡り人間が見た後である |
| B. baseline 1点固定 + 許可集合の合算 | fix の許可 = fix 宣言 ∪ implementation の Modify 宣言 | capture が1回で済む。ただし「implementation 宣言内だが fix 宣言外」の変更を見逃し、Bounded Fixes が緩む。fixAttempts が進むたび許可集合が実質広がっていく |

**A を推奨。** capture のトリガーは workflow.yaml に書かせず、
**「遷移先 step が diff-scope validator を宣言していれば、遷移確定時にエンジンが必ず capture する」**
というエンジン規則にする。宣言忘れが構造的に起きず、review→fix / improve-check→fix /
testing→fix のどの経路でも自動で効く。

なお clipboard 運用では「承認 → 人間がプロンプトを Codex へ貼る」の間に窓が残るが、
数分オーダーであり許容する（M2 の codex executor 化で窓はさらに縮む）。

### どこに記録するか

**専用ファイル `runs/baseline.json`**（runs/ は既存ディレクトリ）。

- state.json に入れない理由: dirty 一覧は数十〜数百行になりうる。state.json は
  人間が読む小さなファイルで、§6.11 の形を崩したくない。**state.json のスキーマ変更ゼロ**で
  済むのは不変条件（run の既存挙動を変えない）との整合でも利点
- `featureRunId` / `taskRunId` が未実装である点: `capturedFor: { step, fixAttempts }` +
  `capturedAt` で run を識別する。将来 taskRunId が入ったら capturedFor に足すだけ
- 冪等性: capture 前に既存 baseline の capturedFor と照合し、**同一キーなら再取得しない**。
  これが resume 安全性の要——resume のたびに再 capture すると、
  **Codex が既に行った変更が baseline に混入して検査が無効化される**
- `aiw new-task` は baseline.json を削除する（前タスクの残骸が次タスクの検査を汚さない）
- Event Log には `baseline.captured` { step, fixAttempts, headSha 短縮形, dirtyCount } と
  `baseline.capture-failed` を記録する（不変条件6: 生 ID を残さない、に session ID は
  関係ないが SHA も短縮形で揃える）

## 課題3: 偽陽性の回避（シナリオ検証）

推奨案（per-step baseline (d) + 宣言パース + exclude）での挙動:

| # | シナリオ | 挙動 | 判定 |
| --- | --- | --- | --- |
| 1 | 開始前から無関係な未コミット変更が多数（実測32件） | baseline の dirty に入りハッシュ不変 → changedDuringStep に含まれない | **違反にしない** ✓ |
| 2 | Codex が宣言外のファイルを新規作成 | baseline にない untracked が出現 | **違反** ✓ |
| 3 | Codex が宣言外の既存ファイルを編集 | baseline にない dirty が出現 | **違反** ✓ |
| 4 | 人間がタスク中に無関係ファイルを編集 | 違反として報告される（下記「判断」参照） | 違反（意図的） |
| 5 | 日跨ぎで人間が別作業 | 4 と同じ。capturedAt を report に併記 | 違反（意図的） |
| 6 | 人間がタスク中にコミット（HEAD 移動） | dirty ベースの判定は継続。headSha 不一致を検知し、`git diff --name-only <baseline>..HEAD` の一覧を**参考情報**として report に添付（違反にはしない） | 警告のみ |
| 7 | 既 dirty ファイルを Codex がさらに編集 | ハッシュ変化で検出。宣言外なら違反（メッセージに「baseline 時点から更に変更された。人間の変更の可能性あり」と明記） | **違反** |
| 8 | ビルド生成物 / node_modules | gitignore 済みなら status に出ず自然除外。tracked 生成物は `settings.diffScope.exclude` で除外 | **違反にしない** ✓ |

### シナリオ 4・5 の判断: 違反として報告する

技術的に「誰が変更したか」は判別不能（git はファイル変更の作者を記録しない）。
選べるのは「検出して人間に見せる」か「見ないことにする」かだけであり、後者は
Codex の逸脱も一緒に見逃す。**検出して見せる**が正しい。理由:

- implementation は report なのでフローは止まらない。scope-violation-report.md に載り、
  review の入力になる。人間は「これは自分の変更」と1秒で判断できる
- fix は halt する。これは偽陽性コストが最も高い点だが、fix の実行時間は短く
  （Codex 実行中に人間が同リポで作業する時間窓が小さい）、halt メッセージに
  「自分の変更が原因なら `aiw baseline capture` 後に `aiw resume`」という復帰手順を出す
- **運用ルールとして「codex ステップ実行中は検査対象リポジトリで並行作業しない」を
  明文化する**（codex-system.md ではなく人間側のルール。context.md か README）

### シナリオ 6 の判断: 違反にせず警告

タスク中のコミットは現運用では人間しか行わない（Codex はコミットしない）。
人間がコミットするとき diff は目視されているはずで、これを違反にすると
「人間の正当な作業を halt で罰する」形になり、validator への信頼を最も損なう。
一方で無言も危険（Codex の変更を人間がまとめてコミットした場合に検出が消える）なので、
**headSha 不一致は必ず report / halt メッセージに参考情報として出す**。

### シナリオ 7 の判断: 違反として報告する（確度の注記付き）

差分から「Codex の分」だけを切り出すことは原理的に不可能。ここで見ないことにすると、
**人間が触り中のファイルが Codex の逸脱の隠れ蓑になる**。違反として出し、
メッセージで「baseline 時点で既に変更があったファイル。人間の変更の可能性もある」と
確度を明示する。復帰手順はシナリオ4と同じ。

## 課題4: baseline の劣化と欠損

第1部の三値 `ValidatorStatus`（passed / failed / skipped）に乗せる。

**分岐は step 名ではなく `onViolation` の宣言で決める。** 現在の workflow.yaml では
`implementation: report` / `fix: halt` なので下表と同値だが、`onViolation` を条件にしておくと
diff-scope を第3のステップへ追加したときも宣言と挙動が自動で一致し、
step 名のハードコードが増えない。

| 状況 | `onViolation: report`（現: implementation） | `onViolation: halt`（現: fix） |
| --- | --- | --- |
| baseline.json が無い / capturedFor が現在の step・fixAttempts と不一致 | `skipped` + skipReason（Event Log と status --summary に出る。導入移行期・手動運用の余地を残す） | **`failed` として halt** |
| checkRepoRoot で git が失敗（リポでない等） | `skipped` + skipReason | **`failed` として halt** |
| 宣言源のセクションが無い（契約違反） | **`failed`**（skipped にしない。report なので止まらないが違反として記録される） | **`failed` として halt** |
| baseline が古い（日跨ぎ） | 自動判定しない。capturedAt を report に併記し人間が判断 | 同左 |
| baseline の headSha が消失（rebase） | 判定に影響なし（SHA は参考情報）。HEAD 比較だけ「不明」と表示 | 同左 |

halt 宣言側を failed に倒す理由: fix の baseline は**エンジンが遷移時に自動取得する**ので、
欠損は「エンジンのバグか手動改変」であり正常系に存在しない。halt 宣言の validator が
skipped で素通りするのは KI-04 で潰したバグクラスの再発になる。
report 宣言側を skipped に留める理由: 検査不能のとき failed にしても遷移は止まらず
（report は止めない）、意味的に「検査できなかった」を「違反があった」と偽ることになる。
skipped + 可視化が正確で、第1部の仕組みがそのまま使える。

なお「宣言源のセクションが無い」だけは report 側でも `failed` にする。artifact-contract が
存在を保証しているはずの構造が無いのは**契約違反**であって「検査できなかった」ではないため
（課題5参照）。

## 課題5: 宣言源のパース

### 抽出

`sections.ts` の `extractSection`（level + text 完全一致、次の同レベル以浅見出しまで）を
**そのまま再利用できる**。実測で確認した対応:

| step | 宣言源 | セクション | 構造保証 |
| --- | --- | --- | --- |
| implementation | context-package.md | `## Modify` | artifact-contract（halt）が `# Files` / `## Modify` の存在を保証済み |
| fix | current-review.md | `### Files To Modify` | artifact-contract（halt、review step で検証済み）が保証 |

`## Modify` は文書中に1つしかない（contract がテンプレ構造を固定している）ため
「# Files 配下か」の親子判定は不要。current-review.md の `### Critical` は
`## Critical` と共存するが、extractSection は level を見るので混同しない（実装済みの挙動）。

### 書式

実物の書式（`` - `path`（付記） ``）に合わせる:

- list item（`- ` / `* ` / `1. `）ごとに、**最初のインラインコード内**をパスとして採る。
  インラインコードが無い行は行頭トークン（最初の空白まで）
- 括弧・注記・行番号指定（`（`:49-50`）` 等）は無視
- パスは checkRepoRoot からの相対。区切りは `/` に正規化し、
  Windows のため**大文字小文字を区別しない比較**にする
- 末尾 `/` の項目はディレクトリ prefix として配下すべてを許可
- **glob は v1 では不採用**。宣言を書くのは research（Claude）であり、書式を強制できる。
  glob 展開の実装ミスは偽陰性（見逃し）に直結するため、必要が実証されるまで入れない
- runtimeRoot 配下のパス（`.ai-workflow2/...`）が宣言に混ざっていても無害
  （ignore 済みで status に現れず、許可集合に余分があっても偽陰性にはならない）

### 見出し欠落・空セクション

- 見出しが無い（extractSection が null）→ **`failed`**（skipped にしない）。
  contract が保証しているはずの構造が無いのは契約違反であり「検査できなかった」ではない。
  implementation は report、fix は halt（onViolation の宣言どおり）
- 見出しはあるが項目ゼロ → **宣言ゼロとして扱う**（全変更ファイルが違反候補になる）。
  「何も変更しないはずの fix でファイルが変わった」を検出する正しい挙動

### 除外

`settings.diffScope.exclude`（workflow.yaml、prefix / 単純 glob の配列）を新設する。
初期値は空で良い——実測のとおり生成物・runtime・エンジンはすべて gitignore 済みで
git status に現れない。tracked な生成物が見つかったときの逃し弁として用意だけする。

---

# 推奨案（まとめ）

選んだ組み合わせ:

1. **ルート分離**: runtimeRoot（既存 resolveRoot / AIW_ROOT）と checkRepoRoot
   （`settings.repoRoot` → 既定 `git -C <runtimeRootの親> rev-parse --show-toplevel`）。
   環境変数・CLI フラグは増やさない。v1 は1タスク1リポジトリ、aiw 自身の改修は
   `repoRoot: tools/aiw` の明示で対応
2. **baseline**: 案(d) HEAD SHA（参考）+ `status --porcelain -uall` の dirty 一覧 +
   各ファイル sha256。**diff-scope を宣言する step への遷移確定時にエンジンが自動 capture**
   （per-step。fix 再入場ごとに再取得）。保存先は `runs/baseline.json`。
   同一 (step, fixAttempts) なら再 capture しない（resume 安全）
3. **判定**: (新規 dirty ∪ ハッシュ変化) − 宣言 − exclude。HEAD 移動は違反ではなく警告
4. **欠損**: implementation は skipped（可視化）、fix は failed（halt）
5. **パース**: extractSection 再利用。インラインコード優先の list item パース。
   見出し欠落は failed。glob 不採用
6. **非対称性の維持**: implementation は report + scope-violation-report.md 生成
   （review の optional input として既に workflow.yaml に宣言済み）、fix は state 更新前に halt

シナリオ1〜8の挙動は課題3の表のとおり。構造的偽陽性（1・8）はゼロ、
残余偽陽性は「人間の並行変更」（4・5・7）のみで、これは検出自体は正しく
（変更は実在する）、帰属だけが不明という性質のもの。report 文面への確度注記と
`aiw baseline capture` + `aiw resume` の復帰手順で運用可能と判断する。

## halt からの復帰手順（fix で偽陽性が出た場合）

1. halt メッセージに違反ファイル一覧・capturedAt・headSha 状態が出る
2. 人間が確認し、自分の変更が原因なら `aiw baseline capture` で取り直す
   （新設 CLI。現在の dirty 状態を「タスク外」として再固定する）
3. `aiw resume` → 再検証で通る

自動再取得にしない理由: resume で無条件に baseline を取り直すと、Codex の逸脱も
baseline に吸収されて検査が消える。**取り直しは人間の明示操作に限る**。

---

# 実装しない判断について

**結論: 実装する価値がある。**

判断根拠は「構造的偽陽性（タスクと無関係な既存 dirty を違反にする）を
baseline 方式で完全に除去できること」が実測で確認できたため。残る偽陽性は
人間の並行変更の帰属不能だけで、これはどの設計でも原理的に除去できず、
かつ「検出して確度付きで見せる」ことが安全網の目的に照らして正しい。

偽陽性が運用で許容できないと判明した場合の後退順序（強い順）:

1. fix の halt を維持したまま、implementation の report を summary 表示のみに縮小
2. fix も report に落とす（Bounded Fixes の強制を放棄。workflow.yaml の
   onViolation 変更のみで可能——非対称性の設計は保ったまま運用で緩める）
3. 検査を「宣言ファイルの存在確認 + 宣言セクションの非空チェック」だけに縮小
4. NOT_IMPLEMENTED へ戻す（skipReason を「偽陽性率により無効化」へ変更。
   第1部の可視化があるので「静かに存在しない」状態にはならない）

どの段階でも「skipped / 無効化が可視である」ことは維持される。

---

# 実装スコープ（承認後）

| ファイル | 内容 |
| --- | --- |
| `src/engine/gitScope.ts`（新規） | checkRepoRoot 解決 / capture / 現在状態との比較 / baseline.json IO。git は `execFileSync` |
| `src/engine/declaredFiles.ts`（新規） | 宣言源パース（sections.ts の extractSection を利用） |
| `src/engine/validators.ts` | `diff-scope` の実装を runOne へ追加、`NOT_IMPLEMENTED` から削除 |
| `src/engine/completion.ts` | 遷移確定時の capture フック（遷移先が diff-scope を宣言する場合のみ）、implementation の report 時に `scope-violation-report.md` 生成 |
| `src/cli.ts` | `aiw baseline capture` コマンド新設、`aiw new-task` で baseline.json 削除 |
| `src/engine/types.ts` | `settings.repoRoot` / `settings.diffScope.exclude` の型追加 |
| `assets/config/workflow.yaml` / runtime `workflow.yaml` | settings 追記（既定は無指定＝自動解決） |
| `test/`（新規テスト） | 一時 git リポジトリでシナリオ1〜8を再現する故障注入テスト（M1.5.3 の diff-scope 分） |
| `docs/aiw-known-issues.md` | NOT_IMPLEMENTED の diff-scope 行削除に伴う更新 |

段階分け: (1) gitScope + declaredFiles + 単体テスト → (2) validator 接続 + capture フック →
(3) scope-violation-report / CLI / 故障注入。各段階で `npm run build` + 既存テストを通す。

CLAUDE.md 不変条件との整合: capture は `aiw run` / `aiw approve` の遷移処理内に入る
（exec には触れない——不変条件1）。state.json のスキーマは変更しない。
validator の追加は「実装」であって既存 validator の緩和ではない（不変条件4）。

---

# 未解決の論点（判断を委ねる）

1. **運用ルールの明文化先**: 「codex ステップ実行中は検査対象リポジトリで並行作業・
   コミットをしない」をどこに書くか（context.md / README / 両方）
2. **fix の許可集合方式の最終確定**: per-step baseline（推奨・案A）で良いか。
   Bounded Fixes をあえて緩めて案B（宣言合算）にする選択もある
3. **`aiw baseline capture` の名前と権限**: 検査を骨抜きにできる操作なので、
   実行時に Event Log へ必ず記録する前提だが、確認プロンプトを挟むか
4. **大文字小文字比較**: Windows 前提の case-insensitive で良いか
   （リポジトリを WSL/mac で扱う将来があるなら git の `core.ignorecase` を読む手もある）
5. **CLAUDE.md 不変条件4の条文**: 本設計の承認をもって「維持対象」が定義されるため、
   注記の文言（別途の記録更新コミットで提案済み）で良いか
