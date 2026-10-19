# 設計: reflection の executor 化と知識の差分サマリ（小枠A）

状態: **設計案・人間の承認待ち**（2026-10-19）。承認後に実装する。末尾の「未解決の論点」に判断の要る点をまとめた。

## 1. 位置づけ

### M4 で自動化しなかった理由と、再検討条件（`design-claude-executor.md` 課題C・決定ログ 2026-08-31）

1. **承認ゲートが無い**唯一の Claude ステップ。自動化の失敗が知識ファイル（context.md / learnings.md / backlog.md）を**静かに汚染**し、以後の全タスクの入力に混入する
2. 得られるのは約 6 分/タスク。知識の汚染は発見が遅れ、遡って直すコストが大きいので釣り合わない
3. **再検討条件**: M5（aiw auto）の無人ループで必要になったとき、**知識ファイルの差分を人間に見せる仕組みとセットでのみ**入れる

### 今（2026-10-19）の状況

- auto の区間で、毎タスク必ず止まる人の番は reflection（A2・clipboard）だけになった（task-planning は小枠B で executor 化）
- 実績: reflection の遷移 182 回・halt 9 回。うち **8 回は `nextPhaseId` の書き漏れ**（feature-continue のとき必須）で、手貼りゆえの失敗
- → 条件の後半「差分を人間に見せる仕組み」をこの枠で作り、セットで executor 化する

### やること / やらないこと

| やる | やらない |
| --- | --- |
| reflection を claude executor で動かす | `auto: true` の付与（→ 論点 5） |
| 知識ファイルのスナップショットと差分サマリ（エンジンの仕組み・ファイル名をエンジンに書かない） | 差分の内容の良し悪しの機械判定（人間が見る） |
| reflection に承認ゲートを足す（→ 論点 1） | バックアップリポ（`.ai-workflow/.git`）への依存（環境固有で、`aiw init` の環境には無い） |
| 却下したら知識ファイルをスナップショットへ戻してから再実行（再実行可能性） | |

## 2. 差分サマリ

### スナップショット（入るときに撮る）

- **対象はエンジンが宣言から導く**: そのステップの `inputs` と `outputs`（+ `optionalOutputs`）の**両方に載っているもの**＝その場で書き換えるファイル。
  reflection なら context.md / learnings.md / backlog.md / research/。**知識ファイルの名前をエンジンに書かない**（宣言が正本）
- 撮るのは claude のステップへ遷移で入るとき（0 バイトスタブと同じ場所・`createOutputStubsFor` の隣）。保存先は `runs/snapshots/<step>/`、記録は `snapshot.captured`
- clipboard のときも撮る（差分サマリは人が貼る運用でも役に立つ。executor に依存させない）→ 論点 6

### 差分（run で出す）

- `aiw run reflection` の検証の前に、スナップショットと現在を比べて **`knowledge-diff.md`** を書く:
  - ファイルごとの増減行数（`git diff --no-index --numstat`。git は diff-scope で既に使っている）
  - 本文の差分（`git diff --no-index`。上限つきで、超えたら「残り N 行は runs/ の全文を見る」）
  - backlog.md は **追加・状態が変わった BL の ID** を1行ずつ（見出し `## BL-` と `Status:` 行の差から機械的に拾う）
- Event Log に `knowledge.diff`（ファイルごとの増減・BL の追加/変更）。drive / auto の停止の1行にも「知識の差分: context +3 / learnings +5 / backlog +1 BL（BL-350）」のように要約を出す

## 3. 承認ゲートと却下（→ 論点 1・2）

- reflection に承認ゲート（`approval.required: true`・`timing: after`）を足す。人間は **`knowledge-diff.md` を見て承認**する。
  承認で postActions（archive / restoreTemplates 等）と遷移が走る（既存の承認の流れと同じ）
- **却下（`onReject: rerun`）では、知識ファイルをスナップショットへ戻してから再実行**する。
  reflection はその場で書き換えるステップなので、戻さずに再実行すると、前回の追記の上にもう一度追記して重複する（backlog の BL が二重になる等）——
  **不変条件2（入力成果物だけから再実行できる）・3（冪等）**の実装。戻したことは `knowledge.restored` に残す

## 4. executor

| 項目 | 内容 |
| --- | --- |
| executor | `claude`（戻し方: この1行を消せば clipboard へ戻る・不変条件5。ゲートと差分サマリは clipboard でも残る） |
| `--tools` | `Read,Grep,Glob,Edit`（**Bash なし**。`design-claude-executor.md` の表のとおり） |
| Edit 対象 | `outputs` / `optionalOutputs` の列挙（context.md / learnings.md / backlog.md / task-metadata.json / current-status.json / research/**） |
| effort | → 論点 4 |
| auto | → 論点 5 |

### 実装上の手当て

- **task-metadata.json のスタブ**: Edit は既存ファイルしか書けないが、`discardTaskMetadata` が毎回消している（空テンプレを残すと file-exists が素通りするため）。
  `completion.ts` の注記「reflection を executor 化するときは、スタブの条件と task-metadata.json の扱いをセットで見直す」に従い、
  claude のときは 0 バイトのスタブを作る。そのとき、書かれなかったときの理由が file-exists（ファイル名を挙げる）から json-schema（パース不能）へ移るので、
  **json-schema の失敗文言に「空（誰も書いていない）」を区別して出す**（判定は変えない・不変条件4）
- **research/ への新しいメモ**: Edit では新しいファイルを作れない（Write はパス制限が効かないので渡さない・§9-2）→ 論点 3

## 5. テスト（予定）

- スナップショット: 入るときに inputs ∩ outputs だけを撮る / 既存は上書きしない / 記録が残る
- 差分: 追記・削除・BL の追加と状態変更が `knowledge-diff.md` と `knowledge.diff` に出る / 差分なしも「差分なし」と出す（不在も記録）
- 却下: スナップショットへ戻ってから再実行し、追記が二重にならない（故障注入: 戻しを外すと二重になる）
- task-metadata.json のスタブ: 書かれなければ json-schema が「空」と言って halt する
- clipboard へ戻しても、ゲート・差分サマリ・却下の戻しが同じに動く（不変条件5）

## 6. 観測（executor 化の後・目安 n=5）

- ゲートでの却下率と理由（差分のどこを見て却下したか）
- 差分の大きさ（ファイルごとの増減行数）と、所要
- `nextPhaseId` の書き漏れの halt が消えたか（before: 9 回中 8 回）

## 未解決の論点（承認時に決めてほしいもの）

1. **承認ゲートを足すか。** M4 の理由の第1が「ゲートが無い」なので、推奨は**足す**（人の仕事は「書いて貼る」から「差分を見て承認する」に軽くなる）。
   足さない案は、差分サマリを次の人の番（task-planning のゲート①）で見せる形——知識の汚染が次のタスクの入力に入った後で見ることになるので推奨しない
2. **却下したときの戻し**: 推奨は「スナップショットへ戻してから再実行」。人が却下の前に知識ファイルを手で直していた場合、その手直しも消える
   （戻す前に `runs/snapshots/` へ今の状態を別名で残す、で救えるようにするか）
3. **research/ の新しいメモ**: Edit では新規ファイルを作れない。(a) 既存のメモの更新だけを許し、新しいメモは learnings.md に「メモ候補」として書く /
   (b) `research/_inbox.md` を固定名のスタブにして、そこへ書かせる（人が後で分ける）/ (c) research/ の新規作成だけは clipboard の運用に残す。推奨は (a)
4. **effort**: 推奨は `high`（知識の品質が以後の全タスクに効く。短いステップなので費用は小さい・task-planning と同じ論理）
5. **auto: true**: ゲートを足せば auto はゲートで必ず止まる（A1）ので、区間に入れても無人で知識が書き換わって先へ進むことは無い。
   それでも段階制（executor 化とゲートで数本観測してから）に従って**今回は付けない**のが推奨
6. **clipboard のときもスナップショットと差分を出すか**: 推奨は出す（差分サマリは executor に依存しない人間側の利得。戻し方を選んでも機能が残る）
