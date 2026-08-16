# ai-workflow2 v1 実行計画 — 放置運用と確認コスト削減

対象: `.ai-workflow2/` (`workflow.yaml` v5) + `tools/aiw` (v0.3)
起点: 2026-07-28 / `currentStep: implementation`, `status: ready`
将来構想（並列化・スマホ操作）は `ai-workflow2-roadmap.md` を参照。

---

## ゴール

```text
1. aiw start "生の依頼"
2. aiw auto   → ゲート①（task-planning後）で停止
3. aiw approve
4. aiw auto   → ゲート②（research後）で停止
5. aiw approve
6. aiw auto   → implementation → review → fix → improve-check → reflection
                → タスク境界で停止
7. aiw status --summary
8. 人間は次だけ見る:
   Open Decisions / Manual Verification Required / High Risk Changes / 最終 git diff
```

**通常時の人間操作は、タスク投入・承認2回・最終確認のみ。**

例外的に増える停止点は2つだけ:

| 停止 | 条件 | v1での扱い |
| --- | --- | --- |
| `clarification-required` | 依頼の情報不足 | 人間が回答 → task-planning 再実行（上限2回） |
| `ux-decision-required` | UX判断が未確定 | 人間が Open Decisions に決定を記入 → research 再実行 |

### 二本立ての目的

自動化だけでは律速がレビューへ移る。**生成と確認可能性を同時に上げる。**

```text
実装全体を読む  →  曖昧な判断・未検証項目・高リスク差分だけ見る
```

---

## 成功条件

### 自動化

- `implementation → review → fix → improve-check → reflection` が無人で完走する
- タスク境界・承認待ち・予算超過・異常時には必ず停止する
- 各ステップは会話履歴ではなく入力成果物だけから再実行できる

### 確認コスト

- Research時点で `Current / Target / Delta / Open Decisions` が出る
- Acceptance Criteria ごとに検証方法が定義される
- Implementation 後に、AC ごとの検証状況と証拠が出る
- 人間がコード全体を読み直さずに、未確認箇所と高リスク箇所を特定できる

---

## 非ゴール（v1ではやらない）

| やらないこと | 理由 |
| --- | --- |
| hooks への移行 | `diff-scope` は事後validatorのまま運用する |
| dynamic workflows / `testing` の独立実装 | `improve-check` は現行どおり `ready-for-reflection` を返す |
| **UX Prototype の自動生成** | v1 は「UX判断が必要だと検出して止まる」まで。生成は v2 |
| **Claude feature session の resume** | 効果未測定。v1 は fresh 固定（後述） |
| ゲートの自動承認 | 実測データがない状態では決めない |
| Azure DevOps 連携 | v1 安定後 |
| worktree / 並行実行 | `singleActiveFeature` のまま。roadmap 参照 |
| validator の削除 | 観測期間中は全て残す |
| 完全な仕様確定 | 曖昧さを消すのではなく、明示して人間判断を局所化する |

---

# 設計原則

## 1. 実行と検証を分離する

`aiw run <step>` の責務は変えない。

```text
aiw exec <step>   AIを呼び、成果物を作る。state は変更しない
aiw run  <step>   検証 → 承認 → 遷移確定 → postActions → state更新 → Event Log
aiw auto          exec / run を停止条件まで交互に回す
```

## 2. ステップ間契約はファイルに置く

> **各ステップは、入力成果物ファイルだけから再実行できなければならない。**

セッション再開は最適化として使ってよいが、正しさの要件にはしない。

## 3. 読者ごとに成果物を分ける ← v4からの主要変更

`context-package.md` に全てを詰めると `token-range` と衝突し、
Codex の入力としても焦点が壊れる。**読者で割る。**

| 成果物 | 読者 | トークン制約 |
| --- | --- | --- |
| `context-package.md` | **Codex**（実装・修正） | token-range を維持（値は workflow.yaml） |
| `research-findings.md` | **人間（ゲート②）+ review / improve-check / reflection** | 制約なし |

Codex は「何を作るか」だけ要る。Current/Target/Delta や Open Decisions は
人間とレビュアーが読むもので、実装者に渡すとノイズになる。

## 4. 仕様を3種類に分離する

Research は仕様書をそのまま正解として転記しない。

```md
# Source Requirements   依頼・仕様書に明示された内容
# Inferred Behavior     既存実装や周辺仕様から推定した内容
# Open Decisions        実装前に人間判断が必要なUX・業務判断
```

## 5. 現状とゴールの差分を実装前に固定する

`# Current Behavior` / `# Target Behavior` / `# Delta` / `# Uncertain Delta`

## 6. 実装結果ではなく検証パッケージを出す

`current-result.md` を確認用成果物にする。詳細は Artifact Contract 章。

## 7. 三値判定を強制する

Acceptance Criteria の状態は `PASS` / `FAIL` / **`NOT VERIFIED`** の三値。
二値だと「検証していない」が静かに PASS へ丸められる。

---

# セッション方針（v1）

## v1 の既定は fresh session

原則2により、セッション再開は**純粋な最適化**である。
したがって **v1 は「常に fresh」を既定とし、不変条件を自明に満たす。**

| 対象 | v1 | 判断時期 |
| --- | --- | --- |
| Claude 全ステップ | **fresh 固定** | M6 で feature-scoped resume の要否を判断 |
| Codex `implementation → fix`（同一Task内） | **resume 可（任意最適化）** | M2 で実装。コードベース再読込のトークンが実際に浮くため |
| Review Audit | **必ず fresh** | 変更なし。追認・自己正当化の回避 |

## Codex resume の必須条件

- session ID がなくても Fix Scope と成果物ファイルから Fix を実行できる
- resume 失敗時は fresh へフォールバックする
- Fix が前回会話の暗黙情報だけに依存してはならない
- `taskRunId` が一致しない session ID は拒否する
- Task Reflection 完了時に必ず破棄する

## runId は session と独立に持つ

`featureRunId` / `taskRunId` は session の有無に関わらず `state.json` に持つ。
Event Log の相関、archive の階層、予算集計に使うため、session を実装しなくても価値がある。

```json
{
  "featureRunId": "feature-20260728-001",
  "taskRunId": "task-20260728-003",
  "sessions": {
    "codexTask": { "sessionId": "...", "taskRunId": "task-20260728-003" }
  }
}
```

生の session ID はログに残さず、hash または短縮識別子だけを保存する。

## Event Log 追加イベント

```text
task-session-created / task-session-resumed / task-session-discarded
session-resume-failed / session-fallback-fresh / session-scope-mismatch
```

---

# Artifact Contract

## context-package.md（Codex入力・token-range 維持）

```md
# Task Summary
# Source Requirements
# Constraints
# Files
## Read
## Modify
## Reference
## Ignore
# Acceptance Criteria Matrix
# Test Strategy
```

`diff-scope` は従来どおり `# Files / ## Modify` を宣言源として使う。**変更なし。**

### Acceptance Criteria Matrix

```md
| ID | Expected Behavior | Verification | Evidence Required |
|---|---|---|---|
| AC-01 | 検索条件がAPIへ渡る | API test | Test name |
| AC-02 | 実行中は再押下不可 | UI test | Screenshot |
| AC-03 | 権限なしでは非表示 | Component test | Test result |
```

## research-findings.md（新規・人間とレビュアー向け・制約なし）

```md
# Current Behavior
# Target Behavior
# Delta
# Uncertain Delta
# Inferred Behavior
# Open Decisions
# UX Assumptions
# Risk Areas
```

## current-result.md（Codex出力・検証パッケージ）

```md
# Summary
# Change Map
# Files Changed
# Acceptance Criteria Verification
# Automated Evidence
# Manual Verification Required
# Unresolved Decisions
# Risk Areas
# Tests Run
# Test Results
# Deviations
```

### Acceptance Criteria Verification

```md
## AC-01
Status: PASS | FAIL | NOT VERIFIED
Evidence:
- test file / test name / screenshot / command output
Notes:
- 必要な補足
```

## current-review.md（追加セクション）

```md
# Specification Coverage Audit
# Acceptance Criteria Evidence Audit
# Manual Verification Audit
# Risk Area Audit
```

## データフロー変更点

```text
research ─┬→ context-package.md ──→ implementation / fix        (Codex)
          └→ research-findings.md ─→ ゲート② / review / improve-check / reflection
```

---

# workflow.yaml の拡張

## executor

```yaml
steps:
  implementation:
    role: codex
    executor: codex
  review:
    role: claude
    executor: claude
```

未指定時は `clipboard`（現行動作）。**ステップ単位で切り替えられる。**

## task input

`user-task.md` の人間による事前整形を廃止する。

```bash
aiw start "生の依頼"
aiw start -            # stdin
```

受信記録を `.ai-workflow2/inbox/request-<timestamp>-<id>.md` へ保存する。

## clarification 分岐（上限つき）

```yaml
task-planning:
  transitions:
    planned:
      next: research
    clarification-required:
      next: task-clarification
      maxRounds: 2        # 超過で escalation halt
```

`task-clarification` は AI ステップではなく人間入力待ち状態。
**`fixAttempts` と同じ思想で有界化する。** 上限超過時は未解決点を
`Open Decisions` へ記録したうえで escalation。

## UX 判断の検出（v1は停止のみ）

```yaml
research:
  transitions:
    research-complete:
      next: implementation
    ux-decision-required:
      next: research        # 人間が Open Decisions に決定を記入後、research 再実行
      parking: true
```

既存の reject → rerun パターンを流用する（`ux-decision.md` を rejection-note 相当として使う）。
**新しいステップも executor も追加しない。**

### 検出基準（research プロンプトへ埋め込む）

- 新しい操作フロー / UI配置変更 / エラー表示変更
- ローディング状態・空状態の変更
- 文言判断 / モーダルか画面遷移かの判断
- 仕様書と既存UXの不整合

---

# M0: 準備

## M0.1 現行タスクを完走

現在の implementation を通常フローで reflection まで通す。クリーンなタスク境界から着手する。

## M0.2 レガシー削除

`src/{heartbeat,prompt,files,policy,state}.ts`（`.ai-workflow/` v0.2 用）を削除。

## M0.3 ベースライン記録

| 指標 | 取得元 |
| --- | --- |
| 手貼り回数 | 手記録 |
| ウォールクロック時間 | Event Log |
| fixAttempts | state.json |
| トークン概算 | 手記録 |
| **人間の確認時間** | 手記録 |
| **git diff を読んだ時間** | 手記録 |
| **再指示回数** | 手記録 |
| **実装後に発見した仕様差分数** | 手記録 |

下4つが M1 の効果測定用。**M1 の前に必ず取る。**

## M0.4 executor 基盤

```text
tools/aiw/src/engine/executors/
├── types.ts       StepExecutor インターフェース
├── clipboard.ts   現行動作（既定・フォールバック）
├── codex.ts       M2 で実装
└── claude.ts      M3 で実装
```

**この時点で挙動は一切変わらない。** 差し込み口を作るだけ。

**完了条件**: 既存テストが通る / 現行挙動が不変 / ベースライン取得済み

---

# M1: Reviewability Layer ← v4から前倒し

**executor 実装に一切依存しない。** プロンプト・Artifact Contract・validator の変更だけ。
クリップボード運用のまま実施する。

## 前倒しの理由

1. 今の手動フローで効果を測れる（自動化のノイズなしで確認時間の改善が見える）
2. 契約変更の検証は人間がループにいるほうが楽
3. 変数を1つずつ動かせる（自動化と契約変更を同時にやると原因を切り分けられない）

## M1.1 research 成果物の分割と強化

- `context-package.md` を Codex入力向けに絞る（token-range 維持）
- `research-findings.md` を新設
- `artifacts:` に必須セクションを宣言し、`artifact-contract` validator を効かせる
- `ux-decision-required` 遷移と検出基準をプロンプトへ追加

## M1.2 result 成果物の強化

`current-result.md` に検証パッケージのセクションを追加。
**`NOT VERIFIED` を許可値に含める**（これがないとAIは PASS へ丸める）。

## M1.3 review の変更

以下を監査させる:

- 実装と Source Requirements の一致
- Inferred Behavior の妥当性
- Open Decisions の無断確定
- AC ごとの証拠の実在
- Manual Verification の漏れ
- High Risk 差分

## M1.4 確認サマリー

```text
Open Decisions: 2
Manual Verification: 1
High Risk Changes: 1
Acceptance Criteria:  PASS: 6  FAIL: 0  NOT VERIFIED: 1
```

**完了条件**

- 人間が確認対象を1画面で特定できる
- git diff 全体を読む前に高リスク箇所が分かる
- M0.3 の確認コスト指標が改善している（**ここで測る**）

---

# M2: Codex側の自動化（implementation / fix）

ウォールクロック最長かつ fix ループで最大3回呼ばれる区間。手貼り削減の効果が最も大きい。

## M2.1 codex executor

```
codex exec --json \
  --output-schema .ai-workflow2/schemas/current-status.schema.json \
  "$(cat codex-system.md context-package.md codex-prompt.md)"
```

- JSONL イベントを `runs/` へ保存
- 最終構造化出力を `current-status.json` へ保存
- `current-result.md` は Codex が直接更新
- exit code / timeout / stderr を Event Log へ記録

## M2.2 task-scoped session resume（任意）

同一Task内の `implementation → fix` のみ。セッション方針章の必須条件を満たすこと。

## M2.3 並行運用

**validator を1つも消さない。** 数タスク回して `json-schema` / `artifact-contract` が
発火しないことを確認する。発火するなら `--output-schema` かプロンプトを直す。**validator を緩めない。**

## M2.4 安全網の検証 ← 飛ばさない

`fix` で意図的にスコープ外編集を誘発し、`diff-scope` が halt することを確認する。
自動実行に切り替えた後も安全網が生きていることの目視確認。

**完了条件**: implementation / fix が無人実行 / 手貼り回数が半減 / validator 維持

---

# M3: Claude側の自動化（review / improve-check / reflection）

M2 と合わせて fix ループが繋がる。

## M3.1 claude executor

Agent SDK の `query()` をステップごとに1回呼ぶ。**fresh session 固定。**

## M3.2 パスを渡す

成果物本文を埋め込まず、ファイルパスを渡す。中身を読むのはエージェントの仕事。
埋め込むとステップ間の会話継続に近づいていく。

## M3.3 tool 制限

| Step | allowedTools | 意図 |
| --- | --- | --- |
| review | Read, Grep, Glob, Bash(git diff), Write | コード変更不可 |
| improve-check | Read, Grep, Glob, Bash, Write | コード変更不可 |
| reflection | Read, Write | ナレッジ更新のみ |

無人実行では尋ねる相手がいないため、ツールコールは設定済み権限ルールに従う。
つまり `allowedTools` が実質的な制限として機能する。

## M3.4 バージョン固定

SDK / CLI / prompt / template / schema を pin し Event Log へ記録。

---

# M4: aiw auto と安全装置

## M4.1 ループ

```text
loop:
  s = readState()
  if s.status == halted:                     stop("halted: " + s.haltReason)
  if s.status == awaiting-approval:          stop("approval: " + s.currentStep)
  if s.status == awaiting-clarification:     stop("clarification")
  if s.status == awaiting-ux-decision:       stop("ux-decision")
  if taskBoundaryReached:                    stop("task-complete")
  if budgetExceeded:                         stop("budget")
  if consecutiveExecFailuresExceeded:        stop("exec-failed")
  exec(s.currentStep)
  run(s.currentStep)
```

## M4.2 feature-continue を自動継続させない ← 最重要

状態機械の**非有界ループは1箇所だけ**:

```text
reflection --> task_planning: feature-continue
```

`fixAttempts` は有界化済みだが、これは feature が終わるまで回り続ける。
`aiw auto` は Reflection 完了後に必ず止める。継続は `aiw auto --continue-feature` のみ。

## M4.3 通知

approval required / clarification required / ux-decision required / halted / task complete

デスクトップ通知（`osascript` / `notify-send`）で十分。凝らない。

## M4.4 status summary

通過Step / fixAttempts / Scope violation / 停止理由 / 経過時間 / 概算トークン /
Open Decisions / Manual Verification / High Risk Changes / AC の PASS・FAIL・NOT VERIFIED

**完了条件**: `aiw start` → 承認2回 → タスク完了まで到達する

---

# M5: 前段の自動化

対象: `task-planning` / `research`

executor は M3 で完成しているので `workflow.yaml` に `executor: claude` を足すだけ。

| Step | allowedTools |
| --- | --- |
| task-planning | Read, Grep, Glob, Write |
| research | Read, Grep, Glob, Write, WebSearch |

加えて `aiw start` と `clarification-required`（上限2）を実装する。

**完了条件**: 冒頭のゴールが完全に再現できる

---

# M6: ソークと v2 判断

2週間、実タスクで運用する。

## 自動化指標

手貼り回数 / ウォールクロック時間 / fixAttempts / トークン / executor失敗回数 / Validator発火数

## 確認コスト指標

人間確認時間 / git diff閲覧時間 / 再指示回数 / 実装後に発覚した仕様差分数 /
Open Decisions数 / NOT VERIFIED数 / **High Risk判定への人間の同意率**

> 「的中率」ではなく「同意率」。的中の ground truth は本番バグとしてしか分からず
> 2週間では測れない。同意率ならソーク期間内で測れる。

## 承認ログ（v2の設計材料）

承認のたびに記録する:

| 項目 | 用途 |
| --- | --- |
| どのゲートか | ①②③ |
| 承認 or 却下 | |
| 却下なら何を直させたか | v2 の条件設計 |
| 承認なら成果物を実際に読んだか | 無条件で通しているゲートの特定 |

## v2 候補

- ゲート①②の条件付き自動承認（**①②は経済的ゲート、③は品質ゲート**という非対称性を利用）
- センシティブパス検出（認証 / migration / CI設定 / シークレット）→ 該当時のみパーキング
- Open Decisions が0 かつ High Risk が0 かつ AC が全て自動検証可能な場合のみ自動通過
- Claude feature-scoped session resume の導入判断

---

# リスクと受容

| リスク | 対応 |
| --- | --- |
| スコープ違反が事前ブロックされない | diff-scope事後検出 + Fix halt + Review report + 最終diff確認の四重で受容 |
| 自動化しても確認時間が減らない | **M1 を M2 より前に置き、M0.3 との差分で測る** |
| 仕様書がUXとして不適切 | Source / Inferred / Open Decisions を分離 |
| AIが仕様を誤抽出 | Current / Target / Delta をゲート②前に人間確認 |
| AIが未検証をPASS扱い | PASS / FAIL / NOT VERIFIED を強制 |
| context-package の肥大 | **読者で成果物を分割（設計原則3）。token-range を維持** |
| clarification の無限往復 | maxRounds: 2 で有界化 |
| 無人暴走 | 停止条件7種 + 予算 + M4.2 |
| 会話履歴依存 | v1 は fresh 固定。resume を正しさの要件にしない |
| SDK / CLI 破壊変更 | pin + version/hash ログ |
| 移行が目的化する | 実タスクを回しながら M 単位で進める |

## ロールバック

各ステップは `executor: clipboard` に戻すだけで現行動作へ復帰する。
`aiw run` の責務を変えないのは、このためでもある。

---

# 依存関係

```text
M0 準備・executor基盤
      ↓
M1 Reviewability Layer   ← executor非依存。ここで確認コストを先に下げる
      ↓
 ┌────┴────┐
 M2 Codex   M3 Claude    ← M2 を先に完了させると効果を早く体感できる
 └────┬────┘
      ↓
M4 aiw auto              ← 放置運用が成立
      ↓
M5 前段・raw task input
      ↓
M6 ソーク → v2判断
      ↓
（roadmap: F1 並列化 / F2 スマホ操作 / F3 統合）
```

**M1 を M2 より前に置くのが v4 からの主要な変更点。**
自動化を先行させると実装量だけ増え、人間確認が新しいボトルネックになる。
また M1 は executor に依存しないため、自動化のノイズなしで効果を測定できる。
