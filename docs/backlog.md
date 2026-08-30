# aiw バックログ

このファイルは `tools/aiw` リポジトリの課題を扱う。アプリ本体の課題は
`.ai-workflow2/backlog.md` を参照すること。

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

## BL-072

- Source: TASK-2026-08-14-hishou-undo-redo / reflection
- Severity: Minor
- Trigger: fix ステップの組み立てを次に変更するとき
- Summary: fix 実行時に implementation Skill / prompt が渡された疑いがある。再現時は `aiw prompt fix` の組み立てを調査し、Fix Scope 制約が確実に結合されるようにする。
- Status: open

## BL-078

- Source: TASK-2026-08-18-m3-preflight / M3 前提の棚卸し
- Severity: Minor
- Trigger: reflection Skill を次に変更するとき
- Summary: `task-metadata.json` の `openDecisions` は reflection 時点の未解決件数を表す、と Skill で定義する。json-schema だけでは時点の意味を固定できない。
- Status: open

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
