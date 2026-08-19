# aiw 既知の問題

判明している不具合と、意図的に**修正していない**項目の記録。着手前に判断が要るものを残す。

修正した項目も削除せず「修正済み」として残し、修正内容と**復旧できない範囲**を明記する。
このファイルはエンジン本体（`tools/aiw`）と同じリポジトリで版管理する。
コードを直したらこのファイルも同じコミットで更新すること。

| ID | 概要 | 状態 |
| --- | --- | --- |
| KI-01 | assets と runtime で同じバージョン番号なのに中身が違う | **修正済み**（M2 Stage3。案 B を採用） |
| KI-02 | archiveArtifacts が2回目以降のタスクを黙ってスキップ | **修正済み**（過去分は復旧不能） |
| KI-03 | token-range の下限が簡潔な小タスクを弾きうる | 未修正（発火したら再調整） |
| KI-04 | skipped を成功として扱う | **修正済み**（コミット `ba2ad72`） |
| KI-05 | 型はあるがエンジンが参照しない宣言（inputs 等） | 未修正（M2 以降で削除判断） |
| KI-06 | diff-scope は1タスク1リポジトリ。ネストしたリポジトリは検査対象外 | 未修正（v1 の既知の限界） |
| KI-07 | verify-local は C#/.NET を検査しない | 未修正（環境要因。実行時にも明示） |
| KI-08 | verify-local のコマンドはシェル経由。特殊文字を含む argv は壊れる | 未修正（運用制約として記録） |
| KI-09 | 「宣言はあるが効いていない」の系譜（testing ステップで運用停止） | **一部修正済み**（testing 削除。残りは M7 判断） |

コードのバグではない「死んだ指示」（プロンプトに残った残骸）は KI 番号を振らず、
末尾の[解消済み: 死んだ指示](#解消済み-死んだ指示プロンプト内の残骸)にまとめる。

---

## KI-01: assets と runtime で同じバージョン番号なのに中身が違う

**状態**: **修正済み**（M2 Stage 3。下記「選択肢」の案 B を採用）。

### 修正内容

環境固有の実行手順を `instructions/local-environment.md` へ切り出し、
**runtime にだけ存在するファイル**にした（assets には置かない。`.gitkeep` も置かない）。
`workflow.yaml` の `research` ステップが `optionalInstructions: [local-environment]` で宣言し、
`assembleStepPrompt` が存在すれば結合、無ければ出力に `(no local-environment.md)` の1行を残す。

結果として `prompts/research.md` は assets と runtime で**同一**になった
（他の分解済みプロンプトも同様）。同じバージョン番号なら同じ内容、という前提が回復している。

問題の性質が「同名ファイルの中身が違う」から「runtime にだけ在るファイル」へ変わったため、
`versions.lock` による乖離警告は不要になった（未実装のままでよい）。

差し込み口は `{{include:}}` のようなテンプレート機構ではなく、
**workflow.yaml の宣言**にした。規約ベースの暗黙 include にすると
「置いたつもりで読まれていない」が起きるため、宣言と実ファイルの対応は
Test 88（宣言した skill / instructions が実在すること）で検査する。

以下は修正前の記録。

### 何が乖離しているか

| ファイル | assets（`tools/aiw/assets/`） | runtime（`.ai-workflow2/`） |
| --- | --- | --- |
| `prompts/research.md` | 2,682 bytes | 6,287 bytes |
| `config/workflow.yaml` | `testCommand: "npm test"` | `testCommand: "./tools/nrun.cmd build && ./tools/nrun.cmd test"` |

`research.md` の差分は runtime 側だけにあるサンドボックス手順のオーバーレイ:

- `# Required Tests` の既定コマンドが `npm run build` / `npm test` ではなく `./tools/nrun.cmd build` / `test`
- **BL-050**: Codex のサンドボックスでは Volta の shim が `%LOCALAPPDATA%\Volta` を検査して
  権限エラーになり `npm` が起動しない。`tools/nrun.cmd` が Volta 展開済みの
  node.exe / npm-cli.js を直接叩いて回避する
- **BL-054**: サンドボックス内で Playwright に backend `webServer`（`dotnet run`）を起動させると
  終了処理が戻らず exit code を得られない。backend 5000 を先に別プロセスで起動し
  readiness を確認してから e2e を実行する手順（PowerShell の `Start-Job` ブロック）
- リポジトリの絶対パス・プロジェクト名・spec 名を含む

**どちらも `versions.prompts.research` は同じ値**（M1 時点で 7）。

### なぜ乖離しているか

runtime 側の内容は**この環境固有**で、汎用テンプレートに入れるべきものではない。

1. `tools/nrun.cmd` はこのリポジトリにしか存在しない
2. BL-050 / BL-054 は Codex サンドボックスのアカウント権限に起因する環境固有の制約
3. 絶対パス・製品名・spec 名が含まれる。`tools/aiw` は独立リポジトリ
   （将来公開の可能性あり）なので、assets へ入れると客先情報が git 履歴に残る

つまり乖離は**事故ではなく意図的な分離**である。問題は、その分離が
**バージョン番号に反映されていない**こと。

### なぜ問題か

`workflow.yaml` の「バージョン分離(rev.3)」は
「変更対象ごとにバージョンを持ち、Event Log に使用バージョンを記録する」ための仕組みで、
**同じ番号なら同じ内容であること**が前提になっている。現状は前提が崩れており、
Event Log の `promptVersion: 7` だけでは assets 版か runtime 版かを区別できない。

区別できるのは `promptHash`（sha256）のみ。`versions.lock` による乖離警告
（設計 rev.5 §1027 のコメントに言及あり）は**未実装**。

### M2 への影響

**codex executor を assets 基準で動かすと BL-050 が再発する。**

M2.1 は `codex exec --json` で `codex-system.md` + `context-package.md` + `codex-prompt.md` を
渡す設計だが、`# Required Tests` の中身は research が生成する。research が assets 版の
プロンプトで動くと `npm run build` / `npm test` を要求し、サンドボックスで npm が起動せず失敗する。

`aiw init` で新しい root を作った場合も同じ問題が起きる（assets からコピーされるため）。

### 選択肢

| 案 | 内容 | トレードオフ |
| --- | --- | --- |
| **A. assets に入れる** | サンドボックス手順を汎用プロンプトへ取り込む | 客先の絶対パス・製品名・spec 名が公開リポジトリの git 履歴に残る。汎用テンプレートとして意味を成さない |
| **B. runtime 専用 include 機構** | プロンプトに `{{include: local/*.md}}` 等の差し込み口を設け、環境固有部分を runtime 側の別ファイルに分離する | エンジンにテンプレート機構が増える。`promptHash` の計算対象をどうするか決める必要あり |
| **C. バージョンを分ける** | `versions.prompts.research` を assets 系と runtime 系で別採番にする（例: runtime は `7-local.1`） | 実装は最小。ただし「同じ番号＝同じ内容」を保証するだけで、内容の重複管理は残る |
| **D. 現状維持 + 明示** | 乖離を許容し、Event Log の `promptHash` を正とする。`versions.lock` 乖離警告を実装して気付けるようにする | 実装は中程度。重複管理は残るが、少なくとも「気付かないまま比較する」事故は防げる |

**採用: B**（M2 Stage 3）。テンプレート構文ではなく workflow.yaml の宣言として実装した。
`promptHash` の扱いは、Step プロンプト単体の hash（`promptHash`）と
Skill / Instructions それぞれの hash（`skillHash` / `instructions[].hash`）を
**別々に記録する**ことで決着した。結合後の文字列に対する hash は持たない。

---

## KI-02: archiveArtifacts が2回目以降のタスクを黙ってスキップする

**状態**: **修正済み**（コミット `aedcde4`）。ただし**過去に失われた成果物は復旧できない**。

### 修正内容

- 退避先を `archive/<feature>/<timestamp>-<task>/` にして構造的に衝突しないようにした
- `existsSync(dest)` の即 return を廃止した。resume の冪等性は
  `pendingTransition.completedPostActions` が既に担保しており、
  このガードは二重の安全網のつもりで「別タスクの上書き防止」として誤作動していた

一時ルートで2タスク連続の reflection を実行し、別ディレクトリが2つでき、
それぞれが自分のタスクの `task-metadata.json` を保持することを実測で確認済み。

### 復旧不能な範囲

2026-07-22 〜 2026-08-04 の間に完了した**約30タスク分の成果物**
（`current-task.md` / `current-result.md` / `current-review.md` / `attempts/`）は
どこにも書き出されていない。`runs/execution-log.jsonl` には遷移とバージョンの記録が
残っているが、**成果物本文は失われている**。この期間のタスクについては
`review-audit` によるトレーサビリティも成立しない。

以下は発見時の記録として残す。

---

### 発見時の記録

### 何が起きているか

`postActions.ts` の `archiveArtifacts` は退避先を
`archive/<featureId ?? "single">/<taskId ?? "task">` で決め、
**`existsSync(dest)` なら即 return する**（冪等性のためのガード）。

`state.json` の `featureId` / `taskId` は**現状ずっと null**（設定する経路が無い）。
したがって退避先は常に `archive/single/task` に固定され、
**一度作られた後は以降のタスクが一切 archive されない。**

### 実測

| 項目 | 値 |
| --- | --- |
| `reflection` からの transition 件数（＝完了タスク数） | 31 |
| `archive/` 配下のディレクトリ数 | 2 |
| `archive/single/task/` の最終更新 | 2026-07-22 17:27 |

`archive/single/task/` には 2026-07-22 のタスクの成果物だけが入っており、
それ以降の約30タスクは**どこにも残っていない**。
（`archive/fuzzy-search-selectors/TASK-2026-07-23-fuzzy-search-core/` は
`featureId` / `taskId` が設定されていた1件のみ）

### 影響

- M1 で `research-findings.md` と `task-metadata.json` を archive 対象に追加したが、
  **この問題があるため実際には退避されない**
- `reflection.md` の「既存 archive にある metadata の tags を優先的に再利用する」が
  永久に空振りする
- `review-audit` のトレーサビリティが成立しない

### 選択肢

| 案 | 内容 |
| --- | --- |
| **A. taskId を必須にする** | `task-planning` が Task ID を宣言し、CLI が `state.json` へ入れる。退避先がタスクごとに分かれる。`task-metadata.json` の `taskName` が既に近い情報を持っている |
| **B. タイムスタンプで一意化** | 退避先を `archive/<feature>/<task>-<timestamp>/` にする。最小の変更で衝突しなくなるが、ディレクトリ名から内容が分からない |
| **C. 冪等ガードを緩める** | `existsSync` ではなく `pendingTransition.completedPostActions` を信頼する。resume の冪等性は checkpoint 側で担保されているため、二重実行の心配は本来ない |

**C が筋としては正しい**（冪等性は既に `completedPostActions` が担保しており、
`existsSync` ガードは二重の安全網のつもりが「別タスクの上書き防止」として誤作動している）。
ただし退避先が同じままだと**前タスクの archive を上書きする**ため、
実質 A か B との併用が要る。

M1.5 で判断する。

---

## KI-03: token-range の下限が、簡潔な小タスクを弾く可能性がある

**状態**: 未修正。実運用で発火したら再調整する。

### 内容

M1 で下限を 500 → 250 へ引き下げた（コミット `89825da`）。判断の根拠は
レビューの実測「最小（AC1 / Modify1）= 268」で、250 ならマージン 18 で通る、というもの。

しかし実装時に別途組んだ**簡潔な最小パッケージ**（1画面・1ファイル・AC1件、
散文を最小限にしたもの）は **163 tokens** で、**現在の下限 250 を割る**。

| サンプル | tokens | min=250 |
| --- | ---: | --- |
| 骨格のみ（見出しだけ） | 118 | HALT（意図どおり） |
| 簡潔な最小パッケージ | 163 | **HALT（意図せず）** |
| レビュー実測の最小 | 268 | 通過 |
| 中規模 | 352 | 通過 |
| 現 runtime の実物 | 1238 | 通過 |

つまり**下限を通るかどうかは research がどれだけ散文を書くかに左右される**。
同じ規模のタスクでも、要点だけ簡潔に書いた research は halt し、
説明を厚めに書いた research は通る。閾値がタスクの規模ではなく文体を測っている。

### なぜ今は直さないか

- 実運用で発火していない（発火したら `context-package.md` を厚くするか、下限を下げる）
- 下げすぎると「スタブ検知」という新しい役割まで失う（骨格 118 との差が詰まる）
- `estimateTokens` は `max(文字数/4, 語数)` のヒューリスティックで、
  日本語では文字数が支配的。**閾値の意味づけ自体がトークナイザ依存**

### 対応の選択肢

| 案 | 内容 |
| --- | --- |
| A. 発火してから下げる | 実データが出るまで動かさない（現状） |
| B. 骨格検知に置き換える | トークン数ではなく「各セクションの本文が空でないか」で判定する。役割に対して直接的だが、新しい validator が要る |
| C. research プロンプトで最低限の記述量を要求する | 閾値ではなく生成側で担保する |

`test/m1-reviewability.test.ts` の Test 28b が現在の境界を assert しており、
下限を 163 未満へ下げると失敗する。**下げる場合はこの KI も一緒に更新すること。**

---

## KI-04: skipped を成功として扱う（M1.5 への申し送り）

**状態**: **修正済み**（コミット `ba2ad72`、M1.5 第1部）。

### 修正内容

- `ValidatorResult` を三値 `status: "passed" | "failed" | "skipped"` へ変更し、
  `{ passed: true, skipped: true }` という「実行していないのに成功」の状態を
  型の上で表現できなくした
- 未実装 validator は `NOT_IMPLEMENTED` マップの skipReason 付きで `skipped` を返し、
  `validation.completed` イベント（results 全件 + skipped 一覧）として Event Log に残る
- `aiw status --summary` と `aiw run` の出力（`ValidationNotice`）に
  report 違反と skipped を表示する

### 残る NOT_IMPLEMENTED 2件の存置理由

| validator | 存置理由 |
| --- | --- |
| `command-exit-code` | testing step（role: cli）自体が MVP スコープ外で、実行経路が存在しない。testing step を動かす milestone で一緒に実装する |

`diff-scope` は M1.5 第2部で**実装済み**のため NOT_IMPLEMENTED から外れた
（設計 `docs/design-diff-scope.md`、コミット `122594e`）。残るのは 1 件で、
リストは空にならないため仕組み自体は維持する。

どちらも「静かに存在しない」状態ではなく、宣言されている step の実行ごとに
skipped として Event Log と summary に出る。

以下は発見時の記録として残す。

---

### 発見時の記録

### 内容

`validators.ts` の `OUT_OF_SCOPE`（`diff-scope` / `command-exit-code`）は
`{ passed: true, skipped: true }` として記録され、**Event Log には一切残らない**
（`validation.failed` のみを記録するため）。`outcome.results` は
どこからも参照されておらず、`skipped` の情報は生成された瞬間に捨てられる。

結果として、`workflow.yaml` に `diff-scope: onViolation: halt` と書いてあっても
**実際には一度も実行されていない**が、ログにも画面にもその形跡が出ない。
「安全網がある」という前提だけが残る。

### M1.5 で必要なこと（両方）

1. `OUT_OF_SCOPE` リストから外す（＝ diff-scope を実装する）
2. **skip を Event Log と `aiw status --summary` に残す仕組みを作る。**
   1 だけやると `command-exit-code` の skip が同じように無言のまま残る

### 同じバグクラスの一覧

「skipped / 部分的失敗を成功として扱う」は、これまでに4例見つかっている:

| # | 箇所 | 状態 |
| --- | --- | --- |
| 1 | `validators.ts` の OUT_OF_SCOPE 素通し | 未修正（本項目） |
| 2 | `drive` の copy-failed 誤報告 | 修正済み（M1 コミット） |
| 3 | `validators.ts` の `skipped` を results へ入れて破棄 | 未修正（本項目） |
| 4 | `archiveArtifacts` の `existsSync` 即 return | 修正済み（KI-02） |

`onViolation: report` の違反がコンソールに出ない件（`printOutcome` は
`transitioned:` と成功表示する）も同じ系統で、M1 時点では未対応。
→ **M1.5 第1部（`ba2ad72`）で対応済み**。`ValidationNotice` が report 違反と
skipped を CLI 出力へ載せる。

---

## KI-05: 型はあるがエンジンが参照しない宣言

**状態**: 未修正。削除するかは M2 以降（executor 設計時）に判断する。
それまでの間、これらの宣言は **workflow.yaml に書いても挙動に一切影響しない**。

### 内容

`types.ts` の `WorkflowStep` に型として存在し、workflow.yaml にも記述されているが、
エンジン（loader / engine / completion / validators / postActions）の
どこからも読まれないフィールドが4つある（2026-08-05 に `src/` 全域を grep で実測。
参照は `types.ts` の型宣言のみ）:

| フィールド | 型宣言 | workflow.yaml での使用例 | 書き手が期待していそうな挙動（実際には無い） |
| --- | --- | --- | --- |
| `inputs` | `types.ts:61` | 全 step | step 実行前の入力ファイル存在確認 |
| `optionalOutputs` | `types.ts:63` | task-planning / reflection | 任意出力の検証・退避対象化 |
| `session` | `types.ts:59` | review-audit（`fresh`） | セッション分離の強制 |
| `standalone` | `types.ts:69` | review-audit | 通常フローからの除外・CLI の起動提案 |

### なぜ問題か

- workflow.yaml が「仕様書のように見えるが一部は飾り」の状態になっており、
  読んだ人間が実在しない安全網（例: inputs の存在確認）を前提にしてしまう。
  KI-04 と同じ「あるように見えて無い」バグクラスの宣言版
- 特に `session: fresh`（review-audit の監査独立性）は設計上「必須」と
  コメントされているが、強制する実装がどこにもない

### なぜ今は直さないか

- `inputs` / `session` は M2〜M3 の executor（プロンプト組み立て・セッション管理）が
  本来の読者であり、その設計時に「実装する」か「型ごと削除する」かを決めるのが自然
- 先に削除すると M2 で同じ宣言を再導入することになり、workflow.yaml の churn が無駄

### 削除判断まで残すべき記録

M2 設計時にこの表を見て、フィールドごとに「実装 / 削除」を明示的に決めること。
決めずに executor を実装すると、`session: fresh` が飾りのまま監査が汚染される。

---

## KI-06: diff-scope は1タスク1リポジトリ。ネストしたリポジトリは検査対象外

**状態**: 未修正。v1 の既知の限界として受容する（設計 `docs/design-diff-scope.md` 課題1）。

### 内容

`checkRepoRoot` は `settings.repoRoot`、未指定なら runtimeRoot の親から
`git rev-parse --show-toplevel` で1つだけ決まる。検査はそのリポジトリに閉じる。

このリポジトリの構成では:

| 対象 | 親リポジトリ（<client-repo>）から見た状態 |
| --- | --- |
| `.ai-workflow2/` | `.gitignore` 済み。git status に出ない（**検査対象外で正しい**） |
| `tools/aiw/` | `.gitignore` 済み **かつ独立 git リポジトリ**。親から完全に不可視 |

つまり **aiw 自身を改修するタスクで `repoRoot` を指定しないと、何を変更しても
diff-scope は「違反なし」を返す**。親と aiw の両方に触るタスクでは、どちらか片方が
必ず盲目になる。

### 対処

- aiw 自身を改修するタスクでは `settings.repoRoot: tools/aiw` を明示する
- 検査範囲は**違反の有無にかかわらず**メッセージへ出す:
  `checked <repoRoot> (nested repos and ignored paths not checked)`
- **変更が1件も観測されなかった場合は文面を変える**:
  `no changes observed in the checked repository — verify repoRoot if unexpected`

3点目は「検査対象に何もなかった」を「検査して問題なかった」に見せないための措置。
無人運転ではメッセージが読まれない前提なので、`aiw status --summary` の Observed 側にも
同じ文面が出る。故障注入 #15（`test/diff-scope-injection.test.ts` の Test 72）が
この文面の分離を検査している。

### 横断検査をしない理由

複数リポジトリを同時に検査すると、baseline / 宣言 / 除外をリポジトリごとに持つ必要があり、
宣言源（`## Modify`）の書式もリポジトリを識別できる形へ変える必要がある。
v1 の運用（1タスク1リポジトリ）では便益が薄いため入れない。

---

## KI-07: verify-local は C#/.NET を検査しない

**状態**: 未修正。環境要因のため v1 では含めない。**実行時にも明示される。**

### 内容

`verify-local` は `Primal.Template.Web.Front/ClientApp` の `tsc --noEmit` のみを実行する。
ソリューションには **csproj 12件**（.NET 10）があるが、`dotnet build` は含めていない。

### 含めない理由（実測）

`dotnet build Primal.Template.sln --no-restore` を実行すると **27秒で exit 1**。
ただし型エラーではなく DLL のロックが原因:

```text
error MSB3027: Primal.Template.Usecase.dll をコピーできませんでした。
  このファイルは "IIS Express Worker Process (24564)" によってロックされています
```

開発機で Visual Studio を開いたまま、あるいはアプリを起動したままだと**常に失敗する**。
これを validator に入れると毎回 report が出て、**「常に違反を出すので誰も見なくなる validator」**
になる。これは diff-scope の設計で最も避けようとした失敗そのもの。

### 帰結（受容するリスク）

**Codex が C# を壊しても verify-local は何も検出しない。** review の目視と、
`testCommand`（testing step、role: cli で MVP 範囲外）だけが頼りになる。

### 記録だけで終わらせない措置

「C# を検査していない」ことが**実行時に見える**ようにしてある。
`settings.verifyLocal.typecheck.notChecked: "C#/.NET"` が検査範囲の注記として、
違反の有無にかかわらず出力される:

```text
typecheck passed — 54 source files in Primal.Template.Web.Front/ClientApp (6.7s); C#/.NET not checked
```

これは `aiw run` の出力・`aiw status --summary` の Observed 側・`test-report.md` の
すべてに出る。diff-scope の `(nested repos and ignored paths not checked)` と同じ論理で、
**検査範囲を毎回明示する**。

### 将来の選択肢

| 案 | 内容 |
| --- | --- |
| A. ロックを避ける | `dotnet build --no-incremental -p:OutputPath=<一時ディレクトリ>` で出力先を分ける。要検証 |
| B. `dotnet format --verify-no-changes` 等の軽量チェックに絞る | ビルド出力を書かないので DLL ロックを踏まない |
| C. CI 側に寄せる | ローカル検証には含めず、PR 時に見る |

---

## KI-08: verify-local のコマンドはシェル経由。特殊文字を含む argv は壊れる

**状態**: 未修正。運用制約として記録する。

### 内容

`runVerifyLocal` は Windows で `spawnSync(..., { shell: true })` を使う。
`npx` が `npx.cmd` であり、Node は shell 無しで `.cmd` を実行できないため。

その結果 **argv 配列はシェル文字列へ連結され、再解釈される**。
引用符・括弧・`&`・`|` などを含む要素は壊れる。

実運用の設定（`["npx", "tsc", "--noEmit", "--listFiles"]`）に特殊文字は無いので問題ないが、
`settings.verifyLocal` にコマンドを追加するときは **シェルセーフな argv に限る**こと。

### 実測で判明した副作用

**`shell: true` ではタイムアウトの痕跡が残らない。**

| shell | status | signal | error.code |
| --- | --- | --- | --- |
| `false` | `null` | `SIGTERM` | `ETIMEDOUT` |
| `true` | **`1`** | `null` | `undefined` |

シェル経由だと kill されたシェルが exit 1 を返すだけで、**本物の失敗と見分けがつかない**。
そのため `runVerifyLocal` は経過時間（`durationMs >= timeoutMs`）でもタイムアウトを判定する。
これが無いと「検査が完了しなかった」を「検査して失敗した」と誤認する。

### 将来の選択肢

`npx` を使わず `node_modules/.bin/tsc` の実体（`.js`）を `node` で直接叩けば shell は不要になる。
ただしパス解決をエンジンが持つことになるので、必要が実証されるまで入れない。

---

## KI-09: 「宣言はあるが効いていない」の系譜

**状態**: testing ステップは**削除済み**（2026-08-07）。残りは個別に判断中。

このコードベースで繰り返し出ている単一のバグクラス。`workflow.yaml` や型に宣言があり、
読んだ人は「効いている」と信じるが、実行経路が無い・結果が捨てられる・成功側へ丸められる。

### 一覧

| # | 宣言 | 実態 | 状態 |
| --- | --- | --- | --- |
| 1 | `diff-scope` validator | `OUT_OF_SCOPE` で `passed: true` を返すだけ | **実装済み**（M1.5 第2部） |
| 2 | `validators.ts` の `skipped` | `outcome.results` に入るが参照 0 箇所 | **修正済み**（M1.5 第1部・KI-04） |
| 3 | `drive` の clipboard コピー | 失敗しても「コピーしました」と表示 | **修正済み**（M1） |
| 4 | `archiveArtifacts` の冪等ガード | 2タスク目以降を黙ってスキップ | **修正済み**（KI-02。過去分は復旧不能） |
| 5 | `settings.contextPackage` | 型はあるがどの validator も読まない | **削除済み**（M1.5 第1部） |
| 6 | `command-exit-code` validator | 宣言していた唯一のステップ(testing)が消え、参照ゼロ | **保留**（M7 で判断） |
| 7 | `steps[].inputs` / `optionalOutputs` / `session` / `standalone` / `defaults` / `auditPolicy` | 型はあるがエンジンが読まない | **未修正**（KI-05） |
| 8 | **`testing` ステップ（role: cli）** | **実行手段が無いのに遷移先として宣言されていた** | **削除済み**（下記） |
| 9 | `config/model-policy.json` | step ごとにモデルを宣言しているが、**エンジンと executor は読まない**（読むのは旧 CLI 経路のみ） | **未修正**（M4 で判断） |

### 8 の実害 — 唯一、実際に運用を止めた

`improve-check` の許可値に `ready-for-test` があり、AI から見れば正当な選択肢だったため
条件が揃うと選ばれた。遷移先の `testing` は `role: cli` で実行手段がなく、
`aiw run` も `aiw next` も袋小路を返し、**`state.json` を手で戻すしか出口がなかった**。

Event Log の実測（削除時点）:

| 事象 | 回数 |
| --- | ---: |
| `improve-check` が `ready-for-test` を返した | **4** |
| 実際に `testing` へ遷移した | **2** |

### 削除内容

- `workflow.yaml`（assets / runtime）から `testing` ステップ、`improve-check → testing`、
  `testing → reflection`、`testing → fix`、`fix.retryPolicy.retryOn` の `test-failed`、
  `settings.testCommand` を削除
- `improve-check` プロンプトの許可値を `ready-for-reflection` / `fix-incomplete` の2つへ
  （`versions.prompts.improveCheck` 3 → 4）
- **`role: "cli"` を型ごと削除**。`testing` が唯一の cli ステップだったため

`test-report.md` は残す。testing の出力ではなく **verify-local(typecheck) の出力**として
review / fix の入力に生きている。

### `role: "cli"` を削除した記録

削除した分岐は `execStep` / `runStep` / `nextSuggestion` / `drive` の4箇所で、
いずれも「実行手段のない role のステップを弾く」防御だった。

**再導入するときは role を型に足すだけでなく、この防御も一緒に戻すこと。**
無いと `runStep` が role を無視して `processCompletion` へ進み、
同じ袋小路がより分かりにくい形で再発する。`types.ts` の `WorkflowStep.role` に
同じ注記を置いてある。

`test/preflight-consistency.test.ts` の Test 20 が
「実行手段のない role を持つステップが宣言されていないこと」を検査しており、
将来 `role` を増やしたときはこのテストが最初に落ちる。

### 9 の実害 — 計測の前提が崩れる

`model-policy.json` は `implementation: { model: "codex", effort: "medium" }` のように
step ごとのモデルを宣言している。しかし参照しているのは `cli.ts` の**旧コマンド経路 3 箇所だけ**で、
`aiw exec` / executor / エンジンはどこからも読んでいない（2026-08-19 に grep で実測）。

M3 で codex executor が動き始めた結果、これは**単なる死んだ宣言では済まなくなった**。
実行に使われるモデルは codex の既定に委ねられ、しかも
**どのモデルだったかは事後に一切分からない**（JSONL にもログにも残らない）。
CLI のバージョンは pin したのに、結果を最も左右する変数だけが野放しだった。

**M3 段階1 での対処**: `settings.codexModel` を新設して `-m` で渡し、
`meta.modelRequested` として Event Log に記録するようにした（指定値であることを名前で明示）。
**`model-policy.json` 自体は触っていない。** フェーズ別モデルの割り当ては
M4（モデル比較実験の設計）と絡むため、そこで判断する。

### このクラスへの構造的な対処（M1.5 で入れたもの）

- **三値の `ValidatorStatus`**: 「実行していないのに成功」を型で表現できなくした
- **`validation.completed` イベント**: skip を含む全 validator の状態を Event Log へ
- **`ValidationNotice`**: `report` 違反と skip をコンソールへ（判定と exit code は不変）
- **`aiw status --summary` の Claimed / Observed 分離**: AI の自己申告とエンジンの観測を混ぜない
- **検査範囲の常時出力**: `checked <repoRoot>` / `N source files ...; C#/.NET not checked` /
  `no changes observed ... verify repoRoot if unexpected`

---

## 解消済み: 死んだ指示（プロンプト内の残骸）

KI 番号は振らない。**コードのバグではなく、プロンプトに残った指示の残骸**であり、
放置しても止まらないが、読み手には「今も効いている規則」に見える点が共通している。

「解消の記録は known-issues に置く」規約に合わせてここに集約する。
分類表（`docs/m2-prompt-decomposition.md` の 🗑 行）にも同じ記録があるが、
**系譜を1箇所で読める状態を保つ**ためにこちらを正とする。

| # | 死んでいた指示 | 出典 | 解消 |
| --- | --- | --- | --- |
| D-1 | 「別途 fix プロンプト（`fix-package.md` 等）を生成しない」 | `prompts/review.md:99` | M2 Stage 3-3 で削除 |
| D-2 | 「独立した `fix-package.md` の作成（禁止）」 | `prompts/fix.md:49` | M2 Stage 3-2 で削除 |
| D-3 | backlog 書式例の見出しが実 ID `## BL-046` | `prompts/reflection.md:93` | M2 Stage 3-5 で汎用例 `## BL-001` へ置換 |

### D-1 / D-2: `fix-package.md`

rev.5 以前の設計では fix 用のプロンプトを別ファイルへ切り出す案があり、
その名残として**両方のプロンプトに禁止事項だけが残っていた**。
現行のどのステップも `fix-package.md` を生成せず、参照もしない。

禁止対象が実在しないため、読み手は「何を禁じられているのか」を判断できない。
削除にあたっては、代わりに積極形の宣言
（「`current-review.md` の Fix Scope がそのまま Fix の契約になる」）を Skill へ残した。

### D-3: 実 ID をテンプレートに使っていた

`BL-046` はこのプロジェクトに実在する backlog 項目の ID。書式例としてそのまま
コピーされると既存項目と衝突する。前回スキャンで検出しながら未対応だった分。

**書式例には実在しない値を使う。** 同種の残骸を探すときは、
プロンプト内の ID・パス・ファイル名が実在物を指していないかを見る。
