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
| `context-package.md` | **Codex**（実装・修正） | 実測後に確定した `token-range` 設定を正本とする |
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

## context-package.md（Codex入力・実測済みtoken-rangeを使用）

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

- `context-package.md` を Codex入力向けに絞る（実測済みのtoken-range設定を使用）
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
- Reviewability Layer導入前後で、仕様差分起因のFix発生率が改善している

---

# M1.5: 無人運転前の安全網実装

M2以降でAI実行を無人化する前に、**現在は素通しされているvalidatorを実装する。**

M0.4時点では `diff-scope` が `passed: true` を返すだけで、`skipped` 情報も利用されていない。
この状態で自動実行へ進むと、安全網が存在するように見えて実際には機能しない。

## M1.5.1 diff-scope validator

宣言源:

```text
context-package.md
└─ # Files
   └─ ## Modify
```

検証対象:

- Task開始時点のbaseline commit
- 現在のgit diffに含まれる変更ファイル
- `Files / Modify` に宣言された許可パス

判定:

```text
implementation:
  scope外変更を検出
  → scope-violation-report.md を生成
  → reviewへ進めるがstatusへ警告を記録

fix:
  scope外変更を検出
  → state更新前にhalt
```

最低限の出力:

```json
{
  "validator": "diff-scope",
  "passed": false,
  "skipped": false,
  "violations": [
    {
      "path": "src/outside-scope.ts",
      "reason": "not declared in Files/Modify"
    }
  ]
}
```

`skipped: true` は成功として扱わず、Event Logとsummaryに明示する。

## M1.5.2 typecheck validator

ローカルで決定的に実行できるtypecheckをvalidatorまたはpostActionとして追加する。

```text
aiw verify-local
├─ typecheck
├─ lint（高速な場合のみ）
└─ 対象範囲の高速テスト
```

v1ではVPN、SSO、ステージング環境を必要とする検証は含めない。

## M1.5.3 故障注入テスト

意図的に次を発生させる。

- implementationでscope外ファイルを変更
- fixでscope外ファイルを変更
- typecheck errorを残す
- validatorを `skipped` にする

期待結果:

| ケース | 期待 |
| --- | --- |
| implementation scope違反 | report生成 + reviewへ警告付き遷移 |
| fix scope違反 | halt |
| typecheck失敗 | state更新前halt |
| validator skipped | 成功扱いせずsummaryへ表示 |

**完了条件**

- `diff-scope` が実際のgit diffで失敗できる
- `fix` のscope違反で確実にhaltする
- `skipped` がPASSへ丸められない
- `verify-local` がホスト環境で安定して動く
- この安全網を確認してからM2へ進む

---

# M2: Prompt Decomposition（executor非依存）

M1で整えた長いStepプロンプトを、クリップボード運用のまま分解する。

ここではProvider共通インターフェースやTool抽象を設計しない。
目的は、現在の指示を責務別に分け、Step Promptをタスク固有情報だけへ縮小すること。

## M2.1 分類

| 現在の指示 | 移行先 |
| --- | --- |
| 今回のTask Summary / Scope / AC | Step Input / Artifact |
| 毎回同じ作業手順 | Skill |
| プロジェクト恒久規則 | Project Instructions |
| 出力形式 | Artifact Contract / JSON Schema |
| 禁止事項 | 実在するPermission / Validator |
| 遷移条件 | workflow.yaml |
| retry / budget | AIW Engine |
| model選択 | model-policy.yaml |
| session管理 | state.json |

## M2.2 Skill配置

```text
.ai-workflow2/
├─ skills/
│  ├─ implementation/
│  │  └─ SKILL.md
│  ├─ fix/
│  │  └─ SKILL.md
│  ├─ review/
│  │  └─ SKILL.md
│  ├─ improve-check/
│  │  └─ SKILL.md
│  └─ reflection/
│     └─ SKILL.md
└─ instructions/
   └─ coding-rules.md
```

この段階ではAIWがSkill本文を読み、従来のclipboard出力へ展開してよい。

## M2.3 implementation Skill

共通手順:

- `context-package.md` を読む
- `Files / Modify` 以外を編集しない
- Acceptance Criteria単位で実装する
- `aiw verify-local` または許可されたローカル検証を実行する
- `current-result.md` に証拠と三値判定を記録する
- `current-status.json` をSchemaどおり出力する

今回のファイル一覧、AC、Task SummaryはSkillへ埋め込まない。

## M2.4 fix Skill

- `current-review.md` のFix Scopeだけを対象にする
- Critical / Majorを優先する
- scope外変更が必要ならescalation
- 修正対象ACを再検証する
- 新しい設計判断を勝手に追加しない

## M2.5 Claude系Skills

review / improve-check / reflectionについても、共通手順と今回固有入力を分ける。

ただし実行方式はまだclipboardのまま維持する。

## M2.6 実測

比較対象:

- Step Promptの平均長
- SkillとStep Inputの重複
- 成果物品質
- Fix発生率
- 手動プロンプト修正回数

**完了条件**

- clipboard運用で現行品質を維持
- Step Promptが今回固有情報へ縮小
- SkillにTask固有情報が混入していない
- Artifact Contract / ValidatorとSkillの責務が重複していない

---

# M3: Codex executor（具体実装を先に作る）

ここで初めてCodex CLIへ接続する。

**Canonical Primitiveや意味ベースTool名はまだ作らない。**
実際のCodex CLIのsandbox、approval、session、出力形式を確認し、その語彙をそのまま使って具体実装する。

## M3.1 事前調査

実装前にローカル環境で以下を確認する。

```bash
codex exec --help
codex --help
```

確認対象:

- 非対話実行
- JSON / JSONL出力
- output schema
- sandbox mode
- approval policy
- network access
- session作成 / resume
- working directory
- timeout / exit code

推測でCLIオプションを書かない。

## M3.2 ExecutorRequest / ExecutorResultを拡張

M0.4のプレーンオブジェクト型を、必要になった実フィールドだけ追加して育てる。

```ts
interface ExecutorRequest {
  stepId: string;
  prompt: string;
  cwd: string;
  outputSchemaPath?: string;
  timeoutMs?: number;
  codex?: {
    // 実際のCLI調査で必要と判明した項目のみ追加
  };
}

interface ExecutorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
  timedOut: boolean;
}
```

将来のClaude共通化を想定して、先に抽象語彙へ置き換えない。

## M3.3 implementation / fix

- M2で分解したSkill、Instructions、Step InputをCodex向け指示へ解決
- Codex CLIを非対話実行
- JSONL、stderr、exit codeを `runs/` へ保存
- `current-result.md` と `current-status.json` を回収
- M1.5のvalidatorを既存の `aiw run` で必ず通す

## M3.4 ローカル検証だけ許可する

v1でCodexから利用する検証は以下に限定する。

```bash
aiw verify-local
```

含めてよいもの:

- typecheck
- lint
- unit test
- 対象を限定した高速integration test（認証・外部環境不要）

含めないもの:

- VPN必須
- SSO必須
- staging
- deploy
- migration apply
-任意の外部ネットワーク操作

## M3.5 task-scoped session resume

同一Taskの `implementation → fix` のみresume可。

- resume失敗時はfreshへフォールバック
- sessionなしでもArtifactから再実行可能
- taskRunId不一致は拒否
- Task Reflection完了時に破棄

## M3.6 故障注入

- Codex timeout
- 不正なJSON
- Artifact欠損
- Schema違反
- scope外変更
- typecheck失敗
- session resume失敗

**完了条件**

- implementation / fixがCodex CLIで無人実行
- M1.5のdiff-scopeとtypecheckが実際に機能
- 手貼り回数が減る
- CLIの実際の語彙と制約が記録される
- clipboardへ即時ロールバック可能

---

# M4: Claude executor + 共通抽象の抽出

Codexの具体実装を踏まえてClaude Agent SDK / Claude Codeの具体実装を作る。
**両Providerの実装が揃った後にだけ、共通部分を抽出する。**

## M4.1 Claude側の実調査

公式CLI / SDKの現在の実機能を確認する。

- non-interactive execution
- stream output
- allowed / denied tools
- working directory
- session / resume
- timeout
- exit / error representation
- Project Instructions / Skillsの読込方法

## M4.2 Claude executor

対象:

- review
- improve-check
- reflection

v1はfresh session固定。

Stepごとの構造的なtool制限:

| Step | 目的 |
| --- | --- |
| review | 読取・検索・git diff・Artifact書込のみ |
| improve-check | 読取・検索・git diff・Artifact書込のみ |
| reflection | Artifact読取・ナレッジ更新のみ |

## M4.3 共通項の抽出

Codex / Claudeの2実装から、実際に共通している項目だけを `ExecutorRequest` へ昇格する。

候補:

- prompt
- cwd
- timeout
- output paths
- session scope
- event stream保存
- resolved Skill / Instructionsのhash

Provider固有項目は各設定へ残す。

```ts
interface ExecutorRequest {
  stepId: string;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  session?: {
    scope: "fresh" | "task" | "feature";
    resumeId?: string;
  };
  providerOptions?: {
    codex?: CodexExecutorOptions;
    claude?: ClaudeExecutorOptions;
  };
}
```

## M4.4 Canonical Primitiveを導入するか判定

次の条件を満たす場合だけ、Step定義をPrimitiveとして抽出する。

- Codex / Claude間で同じ概念が2箇所以上重複
- 両Providerへ損失なくマップできる
- 実行時に参照される
- 抽象化後の方が設定量が減る

意味ベースTool名は、両Providerの実マッピングが確認できたものだけ導入する。

マップできない場合はProvider固有設定を維持する。

## M4.5 Feature-scoped Claude sessionは導入しない

v1はfresh固定を維持し、ソーク後に判断する。
Review Auditは常にfresh。

**完了条件**

- review / improve-check / reflectionが無人実行
- fixループがCodex / Claude間で接続
- 共通抽象が2実装から抽出されている、または抽出しない判断が記録されている
- Provider固有設定が無理に共通語彙へ押し込まれていない

---

# M5: aiw auto と安全装置

M0.4で実装済みの `aiw exec <step>` を、M3/M4のexecutorへ接続する。
**新しいコマンドを二重実装しない。**

## M5.1 ループ

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

## M5.2 feature-continue

Reflection完了後に必ず停止する。

```bash
aiw auto --continue-feature
```

を明示した場合だけ次Taskへ進む。

## M5.3 通知

- approval required
- clarification required
- ux-decision required
- halted
- task complete
- executor timeout

## M5.4 status summary

- 通過Step
- fixAttempts
- diff-scope result
- validator skipped有無
- typecheck結果
- 停止理由
- 経過時間 / 概算トークン
- Open Decisions
- Manual Verification
- High Risk Changes
- AC三値
- 使用Executor / Model
- session fresh / resumed

**完了条件**

- ゲート後の無人区間が完走
- 安全網の実結果を1画面で確認可能
- `aiw exec` は既存実装を再利用

---

# M6: 前段の自動化

対象:

- task-planning
- research

M4で作ったClaude executorを利用する。

## M6.1 raw task input

```bash
aiw start "生の依頼"
aiw start -
```

- requestをinboxへ保存
- Task Planningを起動
- clarificationを上限2回で有界化

## M6.2 UX判断

`parking: true` のような実行時に参照されない宣言は追加しない。

```yaml
research:
  transitions:
    research-complete:
      next: implementation
    ux-decision-required:
      next: research
```

既存のreject / rerunと人間入力待ちstatusで表現する。

## M6.3 Skills

M2で分解したtask-planning / research SkillをClaude executorから利用する。

**完了条件**

- 生の依頼からゲート①まで手貼りなし
- Researchからゲート②まで手貼りなし
- clarification / UX判断の停止が実際のstateで機能する

---

# M7: ソークとv2判断

2週間、実タスクで運用する。

## 自動化指標

- 手貼り回数
- ウォールクロック時間
- fixAttempts
- トークン
- executor失敗回数
- validator発火数
- validator skipped数
- clipboardロールバック数

## 品質・確認指標

- 仕様差分起因のFix発生率
- 再指示回数
- 実装後に発覚した仕様差分数
- Open Decisions数
- NOT VERIFIED数
- High Risk判定への人間の同意率
- git diff閲覧時間（参考値。ベースライン3分のため主要KPIにはしない）

## 抽象化評価

| 項目 | 用途 |
| --- | --- |
| Codex / Claude共通設定数 | 抽象化候補 |
| Provider固有設定数 | 無理な共通化の検出 |
| 共通Primitiveで表現できなかった操作 | 抽象の限界 |
| Step Prompt平均長 | Prompt Decomposition効果 |
| Skill変更回数 | 手順の安定性 |

## v2候補

- 条件付き自動承認
- センシティブパス検出
- Claude feature-scoped session
- UX Prototype生成
- Hooksによる事前ブロック
- verify-integration / verify-staging
- MCP / 外部サービス連携
- worktree / Worker並列化
- スマホ操作

---

# リスクと受容

| リスク | 対応 |
| --- | --- |
| scope違反が事前ブロックされない | v1ではM1.5の事後diff-scope + Fix halt + Review report + 最終diff確認で受容 |
| diff-scopeが素通しになる | `skipped` を成功扱いしない。M1.5故障注入をM2開始条件にする |
| 自動化しても品質が改善しない | 主要KPIを仕様差分起因のFix発生率にする |
| 仕様書がUXとして不適切 | Source / Inferred / Open Decisionsを分離 |
| AIが未検証をPASS扱い | PASS / FAIL / NOT VERIFIEDを強制 |
| context-packageのtoken下限不整合 | 実測後に確定したtoken-range設定を正本にし、文書へ固定値を重複記載しない |
| clarificationの無限往復 | maxRounds: 2 |
| 無人暴走 | 停止条件 + 予算 + Task境界 |
| 会話履歴依存 | fresh fallbackとArtifact再実行可能性を維持 |
| 早すぎる抽象化 | Codex具体実装 → Claude具体実装 → 共通項抽出の順を守る |
| 検証範囲の膨張 | v1はverify-localのみ。外部環境検証はroadmap |
| SDK / CLI破壊変更 | pin + version/hashログ |
| 移行が目的化 | 各Mを実タスクで完了させてから次へ進む |

## ロールバック

各Stepは `executor: clipboard` に戻すだけで現行運用へ復帰する。

`aiw run`、Artifact Contract、M1.5のvalidatorはexecutorから独立させる。
公式CLI接続を切り戻しても安全網は残す。

---

# 依存関係

```text
M0 準備・executor基盤
      ↓
M1 Reviewability Layer                 ← 現在実装中
      ↓
M1.5 diff-scope + typecheck安全網      ← 無人化の開始条件
      ↓
M2 Prompt Decomposition                ← clipboardのまま
      ↓
M3 Codex executor具体実装
      ↓
M4 Claude executor具体実装
   + 2実装から共通抽象を抽出
      ↓
M5 aiw auto                            ← 放置運用成立
      ↓
M6 前段・raw task input
      ↓
M7 ソーク → v2判断
      ↓
roadmap:
F1 worktree / Worker並列化
F2 SSH + tmux → Web / Mobile操作
F3 verify-integration / staging・MCP・外部サービス統合
```

重要な順序は次の通り。

```text
安全網を実装
→ Promptを分解
→ Codexの現実を知る
→ Claudeの現実を知る
→ 共通項だけ抽象化
→ 無人運転
```
