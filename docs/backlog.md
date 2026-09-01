# aiw バックログ

**ここは `tools/aiw`（ワークフローエンジン自身）の課題を置く場所。**
アプリ本体の課題は `.ai-workflow/backlog.md`（runtime 側）にある。

## 2つある理由と、どちらに書くか

| | このファイル | `.ai-workflow/backlog.md` |
| --- | --- | --- |
| 対象 | エンジン・validator・Skill・プロンプト・aiw の文書 | アプリの機能・画面・仕様判断 |
| 置き場 | `tools/aiw`（**独立リポジトリ**。親では gitignore） | 親リポジトリの runtime（**親では gitignore**） |
| 誰が書くか | **人間 / エンジン改修枠**が手で書く | **reflection が自動で転記する** |

⚠️ **reflection はこのファイルを知らない。** `instructions/backlog-rules.md` が指す
`backlog.md` は runtime 側のみで、レビューの `## Backlog` は全てそちらへ入る。
**エンジンの課題が runtime 側に積まれるのは異常ではなく既定の動作**なので、
エンジン改修枠を開くときに runtime 側を見て、該当分をここへ移すこと。
「片方だけ見れば足りる」形にはなっていない。

移管の形は既に固まっている（2026-09-04 時点で **12 件**が移管済み）:
runtime 側の項目を消さず `Status: wontfix (tools/aiw/docs/backlog.md へ移管)` を残し、
中身をこちらへ写す。**runtime 側の行を消すと「無い＝存在しない」に見える**ので消さない。

⚠️ **ID は2ファイルで1つの番号系統を共有する。** 採番前に**両方**を検査すること
（過去に BL-103 で衝突した。その再発防止が BL-103 自身の中身）。

⚠️ **バックアップの単位が別。** ここは AIW リポジトリの履歴に残るが、
runtime 側は親リポジトリで gitignore されており **git に残らない**。
消えて困る判断は、runtime 側に置いたままにしない。

## BL-031

- Source: ユーザー指摘（ワークフロー運用）
- Severity: Minor
- Trigger: ワークフローエンジンの task-planning 入力を改修するとき
- Summary: `user-task.md` と `current-task.md` の近重複を解消する。入力の単一化、明白な単一タスクでの task-planning 簡略化、artifact contract の見直しを検討する。
- Status: open

## BL-063

- Source: TASK-2026-08-13-worktype-master / current-review.md ## Backlog 2
- Severity: Major (deferred)
- Trigger: e2e の変更申告と実体が食い違う事象が再発したとき
- Summary: git 管理外の e2e spec を `diff-scope` が検知できず、`Files Changed` の申告と実体を突き合わせられない。管理対象と validator の境界を見直す。
- Status: open

## BL-071

- Source: TASK-2026-08-14-hishou-undo-redo / current-review.md M4
- Severity: Minor
- Trigger: 文字化け検査コマンドを prompt または review に追加するとき
- Summary: U+FFFD 検査だけでは CP932 誤読後も valid UTF-8 になる文字化けを検出できない。壊れにくい明示リストまたはエスケープ表記と、生バイト確認の手順を定める。
- Status: open

## BL-078

- Source: TASK-2026-08-18-m3-preflight / M3 前提の棚卸し
- Severity: Minor
- Trigger: reflection Skill を次に変更するとき
- Summary: `task-metadata.json` の `openDecisions` は reflection 時点の未解決件数を表す、と Skill で定義する。json-schema だけでは時点の意味を固定できない。
- Status: **done**（2026-08-30。reflection Skill v2 で metrics 各キーの出典を表で明文化。`openDecisions` は「reflection 時点で未解決のもののみ。実装中に解決済みは含めない。判別は research-findings と実装・review の記録の突き合わせ」と定義。`aiw status --summary` の消し込み前の値との時点差も明記）

## BL-082

- Source: TASK-2026-08-19-torikimegai-modonyu-shiro-haikei / current-review.md M1
- Severity: Major (deferred)
- Trigger: validator を次に変更するとき、または measurement completeness の未発火が再発したとき
- Summary: `ac-manifest.json` / `ac-result.json` が無いと measurement completeness validator が常に skipped になる。optional output を緩めず、計画ファイルを生成する側と未検査の可視化を直す。
- Status: open

## BL-088

- Source: TASK-2026-08-20-motodumori-adjustment-propagation / current-review.md ## Backlog
- Severity: Minor
- Trigger: `.cs` を変更するタスクの prompt または local environment 手順を更新するとき
- Summary: `--artifacts-path` を使う場合は build と run を同じ出力先へ通す定型に直す。run だけに指定すると成果物が無く起動できず、指定しないと DLL ロックを回避できない。
- Status: open

## BL-090

- Source: research/codex-self-analysis.md 提案2
- Severity: Minor
- Trigger: 既知の反例がある高リスク構造を research の Constraints に含めるとき
- Summary: 高リスク案ごとに、採用直後に実行する最小の反例テストと棄却値を context package へ記録する仕組みを追加する。
- Status: open

## BL-106

- Source: 旧 BL-101 / 2026-08-25 の Codex 安全停止 / KI-09 系譜 #10
- Severity: Major (deferred)
- Trigger: ソーク明けの最初のエンジン改修枠、または手動退避が維持できなくなったとき
- Summary: `ac-manifest.json` / `ac-result.json` を archive 対象と archive 後削除へ追加し、implementation Skill に前タスクの作業ファイルを確認なしで置き換えてよい旨を明記する。
- Status: **done**（2026-09-04。`archiveArtifacts` へ追加 + `discardAcArtifacts` + implementation Skill v3。2タスク連続の退避を test で固定）

## BL-107

- Source: 旧 BL-102 / KI-09 サブパターン「生成だけ配線して掃除を忘れる」
- Severity: Minor
- Trigger: 新しい artifact をワークフローへ追加するとき
- Summary: artifact 追加時の確認事項を、生成、contract、archive、restore-or-delete、分類表の5点チェックリストとしてテンプレート化する。
- Status: **done**（2026-09-04。`docs/new-artifact-checklist.md`。許可リスト・パス規約・2周目のテストを足して8点にした）

## BL-103

- Source: TASK-2026-08-27-hishou-filter-look / reflection
- Severity: Minor
- Trigger: reflection が backlog へ新規項目を採番するとき
- Summary: 採番前に既存 ID の重複を検査する。アプリと aiw の課題を別ファイルで管理し、同じ番号系統を共有して再衝突しないようにする。
- Status: open

## BL-105

- Source: TASK-2026-08-27-row-select / reflection
- Severity: Minor
- Trigger: invalid status の halt メッセージを次に変更するとき
- Summary: `current-status.json` の `result` が不正な場合、halt メッセージへそのステップの許可値を必ず列挙する。fix Skill / prompt にも許可値を明記する。
- Status: open

## BL-113

- Source: 2026-09-04 のエンジン修正枠で判明（`pathBase` 追加時）
- Severity: Minor
- Trigger: `ac-manifest.json` / `ac-result.json` の形を次に変えるとき、または `aiw init` を新環境へ配るとき
- Summary: `schemas/ac-manifest.schema.json` と `ac-result.schema.json` が **runtime にしか無く、どの validator からも参照されていない**。`aiw init` で配られないので新環境には存在せず、内容が壊れても誰も検知しない。`assets/schemas/` へ移すか、`workflow.yaml` の implementation へ `json-schema` validator を宣言するかを決める（宣言するなら `onViolation` の値も決める）。
- Status: **done**（2026-08-31。「参照する」方向で両方実施。implementation へ ac-manifest / ac-result、fix へ ac-result の `json-schema` validator を `onViolation: report` で配線し、schema は緩い版（必須+型のみ。enum は pathBase / status の実害枠だけ）へ差し替えて `assets/schemas/` から配布。**配線の前提条件として archive + root の実データ全件〔2ペア4ファイル〕が schema を通ることを先に確認した**（4/4 PASS。c-p の「テストがバグと共犯」の教訓の適用）。pathBase の許容値は schema enum（書き手向け契約）と `KNOWN_PATH_BASES`（実行時安全網）の両残しとし、test 124 が機械照合。不在の扱いは optionalOutputs 宣言から skipped、schema 不在は report→skipped / halt→failed。故障注入 4 件を実環境 config のクローンで実測済み。テスト 118-125 新設・全 141 green。**世代注記**: versions へ `schemas.acManifest: 1` / `schemas.acResult: 1` を新設し、`versionInfo()` を step の json-schema 宣言から動的列挙する形へ拡張（指示外の新規追加。登録だけして Event Log に乗らない「宣言はあるが効いていない」を作らないため）。⚠️ `docs/baseline.md` は両リポジトリと git 履歴のどこにも存在せず世代注記をそちらへ書けなかった——本記録が代替）

## BL-116

- Source: M4 設計セッション（Edit-only の検討中に実測で発見）/ 2026-08-31
- Severity: Major (deferred)
- Trigger: research の validator を次に変更するとき、または「書かれていない成果物が通った」事象が観測されたとき
- Summary: **`templates/research-findings.md` は契約の必須8見出しを全て含むため、research が一度も書かなくても `file-exists` と `artifact-contract` を通過する**。`artifact-contract` は `checkMarkdownSections` で見出しの存在しか見ず、`research-findings.md` には `token-range` が掛かっていない（掛かっているのは `context-package.md` のみ）。KI-09 系譜「生成だけ配線して素通りを塞ぎ忘れる」/ `task-metadata.json` で踏んだ罠と同型で、**M4 が持ち込んだものではなく既存**。`aiw status --summary` の Open Decisions 件数など、この成果物を読む下流も同時に静かに壊れる。対処案: (a) `research-findings.md` にも `token-range` の下限を掛ける (b) 契約を「見出しの存在」から「見出し配下に本文があること」へ拡張する（validator 変更）。**実績の確認方法**: Event Log で `research-findings` の artifact-contract が passed でありながら中身がテンプレートと同一だったタスクを数える。
- Status: open

## BL-115

- Source: M4 設計セッション（design-claude-executor.md 課題B）/ 2026-08-31
- Severity: Minor
- Trigger: M4 実装が安定した後の validator 改修枠
- Summary: review 用に diff-scope の「宣言ゼロ」モードを追加し、第2網を本物にする。`declaredFilesFrom` の既定が `context-package.md` のため、review が Modify 集合内のファイルを触っても第2網（diff-scope report）が反応しない。validator 変更にあたるため M4 では見送り（M4 前提3）。それまでは第1網（ツール制限）がこの穴を塞ぐ唯一の防壁。
- Status: open

## BL-114

- Source: BL-113 の実装中に判明（2026-08-31 のエンジン改修枠）
- Severity: Minor
- Trigger: `aiw init` を新環境へ配るとき、または assets↔runtime の宣言差分を次に棚卸しするとき
- Summary: M3 で runtime に配線した `consumer-presence` / `measurement-completeness` validator の宣言が `assets/config/workflow.yaml` に無く、`aiw init` で配られない（grep 0 件）。ac-* の `optionalOutputs` と `artifacts` 定義は BL-113 で assets へ移植済みなので、残る差分はこの validator 2 宣言（`executor: codex` のような環境依存の意図的差分は除く）。意図的な差分と移植漏れを仕分けし、移植するものは test 88 系のテストで固定する。
- Status: open
