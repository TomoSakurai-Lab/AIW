# 設計: task-planning の executor 化と整形契約（小枠B）

状態: **承認済み・実装済み**（2026-10-19）。末尾の「論点の決着」と「実装で設計から変えた点」を併せて読むこと。

## 1. 位置づけと境界

### 経緯（記録の訂正を含む）

- v1 計画の M6.3 に「生の依頼からゲート①まで手貼りなし」がある（`ai-workflow2-v1-plan-reviewed-revised.md`）。
- M4 完了の記録（`design-claude-executor.md` の決定ログ・2026-09-17）は「手貼りが残るのは task-planning と reflection のみ（**自動化しない判断済み**）」と書いた。
  しかし理由と再検討条件が書かれているのは reflection だけで、**task-planning を自動化しない理由はどこにも無い**。
  実態は「判断済み」ではなく「**M4 のスコープ外だっただけ**」で、記録が判断の存在を偽装していた。
- **決着（2026-10-19 人間の裁定）**: M4 時点では理由なきスコープ外。task-planning は executor 化する。
  task-planning の整形は判断を含まない（依頼を計画の形へ写すだけ）ので、人間と機械の境界を越えない。
  **境界は `user-task.md` を人間が書く行為にある。** 依頼の中身を決めるのは人間で、task-planning はそれを漏れなく写す。

### この枠でやること / やらないこと

| やる | やらない |
| --- | --- |
| task-planning を claude executor で動かす | `auto: true` の付与（executor 化と契約で数本観測した後の別判定。research と同じ段階制） |
| 整形契約（依頼の対応表 + ID）と、それを機械検査する validator（halt） | 依頼の各文と計画の対応の**意味の正しさ**の機械判定（無理なので人間がゲート①で見る） |
| task-planning Skill の新設・テンプレートの更新 | 承認ゲート①の自動化（人間のまま） |
| backlog の候補の列挙を task-planning へ置き、research の照合との二重を整理 | reflection の executor 化（小枠A） |

## 2. 整形契約

### 何を縛るか

task-planning の仕事は、生の依頼（`user-task.md`）を `current-task.md` へ整形すること。契約は2つ:

1. **依頼の対応表**: `user-task.md` の各文・各要求が、`current-task.md` のどの要件（Requirements）か対象外（Out of Scope）に写ったかを、
   task-planning 自身が**表で自己申告**する。
2. **ID**: Requirements・Out of Scope・Acceptance Criteria の各項目に ID を振る。AC の ID は research の Acceptance Criteria Matrix まで引き継ぐ。

### 機械が縛るのは「表の完全性」まで（人間の注文 1）

文単位の対応づけを機械で完全判定するのは無理（文の分割も、対応の意味判定も曖昧）。だから validator は
measurement-completeness と同じ型——**内容の正しさではなく、レコードの完全性**を縛る:

- 対応表の見出しがあり、表に1行以上ある
- 各行の「写像先」が空でなく、書かれた ID がすべて `current-task.md` に**実在する**
- Requirements / Out of Scope / Acceptance Criteria の ID が書式どおりで重複しない

**表の内容が妥当か（依頼の取りこぼし・写し間違い）は、ゲート①で人間が表を見て判断する。**
人間の確認作業が「依頼と計画の全文の読み比べ」から「表を眺める」に変わるのが、この契約の人間側の利得。

### 書式（テンプレートに入れる・Skill やプロンプトに再記述しない）

契約の正本は `workflow.yaml` の `artifacts.current-task`（不変条件7）。書き手には**テンプレート**（`templates/current-task.md`）で形を渡し、
Skill は「テンプレートの対応表を埋める」とだけ言う。

```markdown
## Requirements

- R1: …
- R2: …

## Out of Scope

- O1: …

## Acceptance Criteria

- AC-01: …
- AC-02: …

## Request Mapping

| # | 依頼（user-task.md の箇所と要旨） | 写像先 |
| --- | --- | --- |
| 1 | 1 行目: 明細の表を AppGrid にする | R1, AC-01 |
| 2 | 箇条 4: 列構成・表示形式は変えない | R1 |
| 3 | 箇条 5: 文字選択の廃止の可否は判断を仰ぐ | R4 |
| 4 | 1 行目の後半: いまは生の AgGridReact のまま（背景） | G |
```

- ID: `R<n>` / `O<n>` / `AC-<nn>`。写像先は1つ以上の ID をカンマ区切り。`G` は Goal（背景の説明文を受ける。→ 論点 2）
- `## Request Mapping` は契約の見出しの**最後**に足す（artifact-contract は順序付き部分列で照合するので、既存の6見出しは変わらない）

### validator（onViolation: halt・人間の注文 2）

新しい validator 型 `request-mapping`（`artifact-contract` の見出し検査とは別の型にする。Event Log で別に数えられるように）。

| 検査 | 失敗の文言（例） |
| --- | --- |
| `## Request Mapping` があり、表に1行以上 | `current-task.md: ## Request Mapping has no rows` |
| 各行の写像先が空でない | `row 3: empty mapping` |
| 写像先の ID が実在する | `row 2: R7 is not defined in ## Requirements` |
| R / O / AC の ID が書式どおり・重複なし | `## Acceptance Criteria: AC-02 appears twice` |

**halt にする理由**: task-planning の成果物が壊れたまま research へ進むと、下流のすべてが汚染される。入口の契約は固くする。
10-16 07:40 の `current-status.json` の書き忘れによる halt（手貼りゆえ）も、executor 化と契約で消える種類。

## 3. executor

| 項目 | 内容 |
| --- | --- |
| executor | `claude`（戻し方: この1行を消せば clipboard へ戻る・不変条件5） |
| `--tools` | `Read,Grep,Glob,Edit`（**Bash なし**。reflection の設計と同じ型） |
| Edit 対象（`outputs` から列挙） | `current-task.md` / `current-status.json`（+ `feature.md` → 論点 3） |
| 読み取り | 制限なし。`user-task.md` / `context.md` / `feature.md` / **`backlog.md`**（人間の注文 3） |
| モデル | `settings.claudeModel`（pin） |
| effort | → 論点 4 |
| 承認ゲート① | 人間のまま（`approval.required: true`・`onReject: rerun`） |
| `auto` | **付けない**（人間の注文 4） |

### 実装上の手当て: new-task からの入口にスタブが要る

claude executor の書き込みは `Edit`（既存ファイルの編集）だけで、`Write` は渡さない（パス制限が効かないため・設計 §9-2）。
遷移で claude のステップへ入るときは、エンジンが成果物の 0 バイトスタブを作る（`createOutputStubsFor`・`stub.created` を記録）。
**ところが `aiw new-task` は遷移ではなく、`current-status.json` を消す**（テンプレートへ戻すのではない）。
このままだと new-task から始めた task-planning は `current-status.json` を書けずに失敗する。
→ `resetForNewTask` の後、task-planning が claude executor なら同じ `createOutputStubsFor` を呼ぶ（記録も同じ `stub.created`）。

## 4. backlog の候補（人間の注文 3）

### 今の重複

- research Skill の「backlog の Trigger 照合」: `## Modify` のファイル名と主要な識別子で `backlog.md` の open を grep し、`# Delta` に「拾える候補」を最大5件
- 手貼りの task-planning でも、人間（または貼った先の AI）が `# Task` に「拾う Backlog」を書いている（直近の例: `BL-338` / `BL-339`）

### 整理案

照合の**鍵**が段階で違う。task-planning が持つのは依頼の言葉（画面名・コンポーネント名・依頼に書かれた BL-ID）で、
research が持つのはコードの言葉（`## Modify` のファイル名・識別子）。同じ grep の二度打ちではないが、候補の列挙が2箇所にあるのは整理する:

- **task-planning**: 依頼の言葉で `backlog.md` の open を照合し、`## Backlog Candidates`（任意の見出し）に ID + 1行を**列挙だけ**する（最大5件）。
  拾うかはゲート①で人間が決める。拾ったものは `# Task` の「拾う Backlog」へ
- **research**: 照合の節を縮小し、**task-planning の候補を引き継いだうえで、`## Modify` のファイル名でだけ追加照合**する
  （依頼の言葉での照合はしない＝同じ鍵の grep を2段でやらない）。→ 論点 1

## 5. Skill・プロンプト・版

- `assets/skills/task-planning/SKILL.md` を新設（手順: 依頼を読む → 単一 / feature の判断 → テンプレートを埋める → 対応表を作る → backlog の候補を列挙 → status）。
  見出しの一覧や表の書式は書かない（テンプレートと `artifacts` が正本）
- `prompts/task-planning.md` は、見出しの一覧の再記述を Skill / テンプレート参照へ寄せて縮める（`m2-prompt-decomposition.md` の分類表に行を足す）
- 版: `versions.skills.task-planning` 新設 1・`templates.current-task` / `prompts.task-planning` / `workflow` を上げる。research Skill（論点 1 次第）
- runtime: `steps.task-planning.executor: claude`・`skill: task-planning`・validators に `request-mapping`

## 6. テスト（予定）

- `request-mapping`: 表なし / 空行 / 実在しない ID / ID の重複 / 書式違反 → failed（halt）、正しい表 → passed。BOM（BL-285）も含めて読む口は同じ
- 実物の fixture: 直近の `current-task.md` を新書式へ写した版で passed、写像先を1つ壊した版で failed
- new-task の後にスタブが作られ、`stub.created` が残る（claude のときだけ・clipboard では作らない）
- clipboard へ戻した設定で既存の task-planning の経路が通る（不変条件5・同じコミット）
- Test 88（宣言したファイルの実在と versions）に task-planning Skill が載る
- 変異: 実在検査を外すと落ちることを確認

## 7. 観測（executor 化の後）

- ゲート①の却下率（`approval.rejected` / task-planning）と、却下の理由が「対応表の取りこぼし」だったか
- `request-mapping` の halt 件数と内訳
- task-planning の所要（手貼りの時間は記録が無いので before は取れない。after だけ記録する）
- 数本（目安 n=5）観測してから、`auto: true` への組み入れを別に判定する

## 論点の決着（2026-10-19 人間の裁定）

1. **backlog 照合の分担: 承認。** task-planning は**依頼の言葉**（画面名・コンポーネント名・依頼に書かれた BL-ID）で、research は **`## Modify` のファイル名**で照合する。
   **照合の鍵が違うので二度打ちではない**（research の廃止は、ファイル名でしか当たらない BL を拾えなくするので採らない）。research Skill v12
2. **写像先に `G` を許す: 承認（条件つき）。** ⚠️ **G へ写像された文は実装への拘束力を持たない**——G 行きは「取りこぼしていない」の証明であって要求化ではない。
   この意味論をテンプレートと Skill に明記した。何でも G へ流して R を薄くする抜け道を塞ぐため、review の Specification Coverage Audit の既存項目に
   「G へ写された行に要求らしき文が落ちていないか」を1句足した（review Skill v8）
3. **feature.md のスタブ: 承認。**（実装は下の「変えた点」1 のとおり、`stub: true` の宣言で opt-in）
4. **effort: high を承認。** runtime の `steps.task-planning.effort: high`
5. **逆方向（依頼に由来しない要件）: 「見送り」ではなく「表の形式で無料にする」へ修正。** `### Added Requirements` を必須の節にし、
   依頼に由来しない R を根拠1行つきで自己申告させる（無ければ「なし」）。**表のどの行からも指されず、この節にも無い R は halt**——
   validator を増やさず、request-mapping の表の完全性の一部として扱う。task-planning が依頼に無い要件を勝手に足す（整形が創作になる）のは
   executor 化の固有リスクで、それを形式で可視化する

## 実装で設計から変えた点（2026-10-19）

1. **feature.md のスタブは opt-in にした。** 設計案は「`optionalOutputs` もスタブの対象に含める」と書いたが、スタブ作成には既存の規律
   「optionalOutputs は含めない（不在が正常なものに存在を作ると skipped を握り潰す）」がある（`completion.ts`）。全体を変えるとこの規律が一般に壊れるので、
   `FileRef.stub: true` を宣言した optionalOutputs だけを対象にした（task-planning の feature.md だけに付けた）
2. **review の1句は「パリティ監査」ではなく「Specification Coverage Audit」に入れた。** パリティ監査は兄弟機能の棚卸しの検査で、
   G の逃げ道は要求の網羅の検査なので、意味の合う既存項目へ足した
3. research の AC Matrix は「ID は `current-task.md` の AC の ID をそのまま引き継ぐ（足す AC は続きの番号）」に変えた（設計 §2 の「AC の ID は research まで引き継ぐ」の実装）
4. new-task のスタブは `createOutputStubsFor` を再利用し、記録は `stub.created`（`via: "new-task"`）。空の current-status.json は json-schema が halt するので、
   「まだ誰も宣言していない」は保たれる

## （承認前の）未解決の論点

1. **research の照合の扱い**: 上の整理案（research は task-planning の候補を引き継ぎ、`## Modify` のファイル名でだけ追加照合）でよいか。
   それとも research の照合の節を**廃止**するか。廃止すると、依頼の言葉に出ずコードを読んで初めて分かる候補（実例: ファイル名でしか当たらない BL）は拾えなくなる
2. **背景の文の写像先**: 依頼には要求でない説明文（「いまは生の AgGridReact のまま」など）が混じる。写像先に `G`（Goal）を許すか。
   許さないと、背景の文が無理に R / O へ押し込まれるか、表から落ちる（＝完全性の検査が形だけになる）
3. **`feature.md` の作成**: 複数フェーズの feature を始めるときだけ task-planning が `feature.md` を新規に作る。Edit しか無いので、ファイルが無いと作れない。
   普段は種（テンプレート）が残っているが、feature-complete の後は archive へ移されて無くなる（`fileFeatureMd`）。
   調査の結果（2026-10-19）: エンジンは feature.md の**存在**ではなく **Phase の一覧**で feature を判定する（`parseFeaturePhases`。一覧が無ければ単一タスク扱いで、
   archive もしない）。だから **0 バイトのスタブは「単一タスク」と同じ意味になり、害が無い**。
   (a) feature.md が無ければスタブを作る（`optionalOutputs` もスタブの対象に含める）/ (b) feature の開始だけ clipboard に残す /
   (c) 人間がテンプレートから用意する。**推奨は (a)**
4. **effort**: 既定は low（`settings.claudeEffort`）。入口の品質が下流を決めるので research と同じ `high` を推奨（所要は短いステップなので費用は小さい）
5. **逆方向の検査**: どの依頼行からも指されない Requirements（依頼に無い要件の追加）を検出するか。根拠のある追加（ビルド・既存テストを壊さない等）もあるので、
   機械で落とすのではなく、表に「依頼外の要件」として理由つきで載せる形にするか、今回は見送るか。私の推奨は**今回は見送り**（人間の注文の範囲外で、ゲート①で見える）
