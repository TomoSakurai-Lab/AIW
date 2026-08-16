# AI Software Development Workflow 設計書 (rev.5)

---

## 0. 改訂履歴

| rev | 内容 |
|-----|------|
| 1 | 初版。1ヶ月の実運用を反映した現行設計。 |
| 2 | Fixループの閉塞(fixAttempts + maxRetries)、Testingステップの正式定義(role: cli)、current-status.json による機械可読な分岐契約、マルチフェーズ進行ループ、Review Audit の独立セッション化、diff突合検証、試行履歴の保持。 |
| 3 | WorkflowStep型の共通化と構造化入力、Validatorプラグイン化(onViolation付き)、current-status.json のJSON Schema検証(構造検証に限定)、Artifact Contract の導入とValidatorへの統合、ApprovalPolicy強化(reject遷移・autoApprove・timeout)、バージョン分離とcontentHash検証、Event Log の導入。 |
| 4 | 実装前修正: current-review の Artifact Contract に `### Critical` / `### Major` を追加、`WorkflowStep.id` のローダー注入規則、fixAttempts の加算タイミング確定(入場確定時加算)、Step 完了処理順序の定義(postAction 失敗時の halt を含む)、`status.step` と実行 Step の一致検証の追加。fixAttempts 加算主体の文言統一。 |
| 5 | 永続バックログ `backlog.md` の導入: Reflection が `current-review.md` の Backlog セクションを出典タスクID付きで転記・解消済み項目を消し込み、Task Planning が optional input として参照する。アーカイブに埋没していたバックログの回収経路を確立。 |

---

## 1. 目的

このワークフローは、設計品質・レビューの厳密さ・トレーサビリティ・再利用可能な学習を保ちながら、ソフトウェア開発を加速することを目的とする。

運用モデル:

- **Claude** はアーキテクチャ、計画、調査、レビュー、振り返り、ナレッジ管理を担う。
- **Codex** は実装と限定的な修正を担う。
- **CLI** はワークフロー状態、プロンプト配送、ファイル遷移、検証、そして将来的な自動化を担う。
- **人間** は重要な境界における承認権限を保持する。

現行ワークフローは約1ヶ月の実運用を経て安定しており、オーケストレーションの自動化を開始できる段階にある。

---

## 2. エージェントの責務

### Claude

Claude は 1 feature につき 1 セッションで動作し、現在のフェーズに応じて役割を切り替える。

```md
You are AI Software Engineering Agent.

Roles:
- Research
- Planning
- Review
- Reflection
- Knowledge Management

Switch roles based on Current Phase.
Maintain context across the same session.
```

各プロンプトはフェーズ宣言で始まる。

```md
# Current Phase

Research
```

サポートするフェーズ:

- Task Planning
- Research
- Review
- Review Audit
- Improve Check
- Reflection

> **セッションモデルの位置づけ(rev.2)**: 本設計のファイル契約(current-task / context-package / current-review / current-status)は各フェーズをほぼステートレスに実行できるよう完備されている。「1 feature 1 セッション」は Phase 1(手動運用)における利便性であり、**契約はセッションではなくファイルにある**。Phase 2 以降の API 自動実行では各呼び出しはステートレスになる前提で設計する。

**Review Audit の例外(rev.2)**: Review Audit は監査の独立性を担保するため、feature セッションを使い回さず必ず新規セッション(`session: fresh`)で実行する。自分の書いたレビューを同一コンテキストで監査すると検出力が落ちるためである。

### Codex

Codex は実装ワーカーである。セッションは feature 単位ではなくタスク単位とする。

責務:

- 必要最小限のコンテキストのみを読む。
- 依頼されたタスクを実装する。
- 不要なリポジトリ探索を避ける。
- 最小限の関連テストを実行する。
- `current-result.md` を更新する。
- Fix フェーズでは承認された Fix Scope のみを適用する。

### CLI

CLI は決定論的な状態管理とオーケストレーションを担う。

CLI が(AI ではなく)更新するもの:

- 現在のワークフローステップ
- Feature ID / Phase ID / Task status
- 完了状態・リトライ状態・アーカイブ状態
- `feature.md` の Current phase(Reflection の宣言に基づく)
- fix 試行カウンタ、クリーンレビュー連続カウンタ

AI は「タスクを single にするか phase 分割するか」「次フェーズはどれか」といった**意味的判断**を行うが、状態遷移そのものは所有しない。AI の判断は `current-status.json` による**宣言**として CLI に渡され、CLI が検証のうえ状態へ反映する。

---

## 3. セッションモデル

- **Claude**: 1 feature 1 セッション。Task Planning → Research → Review → Improve Check → Reflection を同一セッションで処理する。新しい feature は新しいセッションで開始する。
- **Codex**: 実装・修正タスクごとに個別セッション。
- **Review Audit**: 常に新規セッション(§2 参照)。

---

## 4. ワークフロー概観

```text
Task Input
   │
   ▼
Task Planning ──[承認①]
   │
   ▼
Research ──[承認②]
   │
   ▼
Implementation
   │
   ▼
Review ──[承認③: Fix Scope]
   │
   ├── ready ─────────────────────────────┐
   │                                      │
   └── fix-required                       │
          │                               │
          ▼                               │
         Fix ◄──────────────┐             │
          │                 │             │
          ▼                 │             │
     Improve Check          │ (Fix入場確定時に CLI が
          │                 │  fixAttempts加算 §7.6、
          ├── fix-incomplete ┘  上限超過で halt →
          │                 │  人間へエスカレーション)
          ├── ready-for-test│
          │      │          │
          │      ▼          │
          │   Testing       │
          │      │          │
          │      ├── test-failed ─┘
          │      └── test-passed ─┐
          │                       │
          └── ready-for-reflection┤
                                  ▼
                             Reflection
                                  │
                    ├── feature-continue → Task Planning(次フェーズ)
                    └── feature-complete → Complete
```

通常パスの外側に、定期的な Review Audit を置く。

```text
Recent Task + Result + Review + Diff
                │
                ▼
      Review Audit(新規セッション)
```

### Fix ループの終了保証(rev.2)

Improve Check の `fix-incomplete` と Testing の `test-failed` は、いずれも**同一のリトライ予算** `fixAttempts` を消費する(初回 + 差し戻し `maxRetries` 回)。予算を分けると「Fix 上限 → テスト失敗 → さらに Fix 上限」という長いループが構成できてしまうためである。上限超過時、CLI は状態を `halted` にし、`haltedReason` を記録して人間へエスカレーションする。自動では先に進まない。

---

## 5. フェーズ定義

## 5.1 Task Planning

### 目的

適切なタスク構造を決定する。

### 責務

- 依頼内容を理解する。
- 単一タスクかマルチフェーズ feature かを判断する。
- フェーズ分解が必要な場合のみ `feature.md` を作成する。
- `current-task.md` を作成する。
- **バックログ解消タスクの場合(rev.5)**: `backlog.md` の該当項目(例: `BL-003`)を参照し、`current-task.md` に出典(バックログ ID と元タスク ID)を記録する。Research はこの出典から `archive/` 内の元レビュー文脈を辿れる。
- 計画後に停止する。

### 禁止事項

- 実装の調査、ソースコード変更、Codex プロンプト生成、実装開始、次の CLI コマンドの出力・実行。

### 入力

- `user-task.md` / `context.md`
- optional: `feature.md`(マルチフェーズ継続時)、`backlog.md`(積み残し解消タスクの参照用・rev.5)

### 出力

- 必須: `current-task.md`、`current-status.json`(result: `planned`)
- 条件付き: `feature.md`

### 承認ゲート①

Task Planning 完了後、人間がタスク分解を承認する。マルチフェーズ feature の次フェーズ開始時(§5.7 参照)もこのゲートを通る。

---

## 5.2 Research

### 目的

計画済みタスクを、最小限だが十分なコンテキストを持つ実装可能パッケージへ変換する。

### 責務

- タスクの同定、Single / Phase 分類の確認。
- 要件分析、実装に必要なリポジトリ領域のみの調査。
- 制約・既存設計の特定。
- 読む・変更する・参照する・無視するファイルの定義。
- テスト定義、実装指示の生成。

### 出力

- `context-package.md`(トークン範囲検証あり: §7.2)
- `codex-prompt.md`
- `current-status.json`(result: `research-complete`)

### 禁止事項

- 実装、アプリケーションソースの変更、正当化のない広範なリポジトリ探索。

### 承認ゲート②

実装開始前に人間が承認する。

---

## 5.3 Implementation

### 目的

リサーチパッケージで定義されたタスクを実装する。

### Codex 入力

- `codex-system.md` / `context-package.md` / `codex-prompt.md`

Codex はデフォルトで長期コンテキスト全体を読まない。

### 実装プロンプト

```md
Read:

- codex-system.md
- context-package.md
- codex-prompt.md

Implement codex-prompt.

Use context-package as minimal context.

Avoid unnecessary repo exploration.

Update current-result.md.

Run minimal tests.

Write current-status.json with result "implemented".
```

### 出力

- ソース変更
- `current-result.md`(CLI が `attempts/result-<n>.md` へ複製して履歴保持)
- 最小限の関連テスト結果
- `current-status.json`(result: `implemented`)

### スコープ検証(rev.2)

CLI は git diff を `context-package.md` の Files > Modify と突合する。逸脱を検出した場合は halt せず `scope-violation-report.md` を生成し、Review への入力に自動添付する(自動 Critical 候補としてレビュアーが判定)。

---

## 5.4 Review

### 目的

実装の正しさを評価し、境界の明確な Fix Scope を生成する。

### 入力

- `current-task.md` / `context-package.md` / `current-result.md`
- Git diff / 関連ソースコード / テスト結果
- `scope-violation-report.md`(存在する場合)

### 出力構造

`current-review.md` は Artifact Contract(§7.4)により以下のセクション構造を必須とする。

```md
# Summary

## Critical

## Major

## Minor

## Good

## Backlog

## Ready

## Fix Scope

### Files To Modify

### Critical

### Major

### Acceptance Criteria

### Test Required
```

### レビュールール

- Review フェーズは Codex 用の fix プロンプトを別途生成しない。レビュー成果物自体が承認済み `Fix Scope` を含み、**そのまま Fix の契約になる**。
- `current-status.json` の result は `ready` または `fix-required`。

### 承認ゲート③

Fix Scope を人間が承認する。承認された Fix Scope が Fix フェーズの唯一の作業範囲となる。

---

## 5.5 Fix

### 目的

承認されたブロッキング問題のみを修正する。

### Codex 入力

- `codex-system.md` / `context-package.md` / `current-review.md`
- `test-report.md`(Testing 失敗経由で差し戻された場合のみ)

### Fix プロンプト

```md
Read:

- codex-system.md
- context-package.md
- current-review.md
- test-report.md (if exists)

Use only Fix Scope.

Fix Critical/Major only.

Update current-result.md.

Write current-status.json with result "fixed".
```

### 禁止事項

- Critical / Major の修正に必要な場合を除く Minor 修正。
- スコープ拡大、無関係なリファクタリング、独立した `fix-package.md` の作成。

### スコープ検証(rev.2)

Fix の diff は `current-review.md` の Fix Scope > Files To Modify と突合する。Bounded Fixes 原則に基づき、Implementation より厳格に、**逸脱は即 halt** とする。

### リトライポリシー

```yaml
retryPolicy:
  counter: fixAttempts
  maxRetries: 2          # 初回 + 差し戻し2回 = 最大3回実行(上限判定は maxRetries + 1)
  retryOn:               # リトライとみなす差し戻し元(カウント条件ではない: §7.6)
    - fix-incomplete     # Improve Check からの差し戻し
    - test-failed        # Testing からの差し戻し(同一予算)
  onExhausted: escalate  # halted にして人間へ
```

**加算タイミング(rev.4)**: fixAttempts は Fix への入場が確定した時点で CLI が加算する(初回入場も 1 回として数え、上限超過なら Fix を開始せず halt)。詳細は §7.6。

---

## 5.6 Improve Check

### 目的

ブロッキングなレビュー指摘が解消されたことを検証する。

### 主ルール

Improve Check は Critical を検証する。Major / Minor はレビューポリシーに応じて backlog へ移動できる。

### 出力(3値判定・rev.2)

`current-status.json` の result は以下のいずれか一つ。判定基準はプロンプト側の記述と必ず一致させる。

| result | 基準 |
|--------|------|
| `ready-for-test` | Critical 全解消、かつ Fix Scope の Test Required が未実行 |
| `ready-for-reflection` | Critical 全解消、かつ Test Required も充足済み(または不要) |
| `fix-incomplete` | 未解消の Critical が残存 → Fix へ差し戻し。fixAttempts は Fix 入場確定時に CLI が加算(§7.6) |

### 責務

- 各 Critical の解消確認、Acceptance Criteria の充足確認。
- 明白なリグレッションがないことの確認。
- 必要な場合を除き、フルレビューを再実施しない。

---

## 5.7 Testing(rev.2 で新設)

### 目的

Fix Scope の Test Required を実行し、修正が実際に動作することを検証する。

### 実行主体

**role: cli**。テスト実行は決定論的処理であり AI に委ねる理由がないため、CLI が `settings.testCommand` を実行し、終了コードから `current-status.json` を生成する(Deterministic State 原則)。model-policy に testing のモデルエントリは持たない。

### 入力 / 出力

- 入力: `current-review.md`(Test Required の対象範囲の特定に使用)
- 出力: `test-report.md`(標準出力・失敗テスト一覧を CLI が整形)、`current-status.json`

### 遷移

- `test-passed` → Reflection
- `test-failed` → Fix(`test-report.md` を添付、fixAttempts を共有)

---

## 5.8 Reflection

### 目的

完了した作業を再利用可能なプロジェクト知識へ変換し、一時的なワークフロー成果物をリセットする。

### 入力

- `context.md` / `current-task.md` / `current-result.md` / `current-review.md`
- `learnings.md` / `backlog.md` / `research/` / 関連する実装結果
- `feature.md`(存在する場合)

### 責務

- 長期コンテキストと再利用可能な学習の更新。
- 適切な場合の research 知識の更新。
- **バックログの転記と消し込み(rev.5)**:
  - `current-review.md` の `## Backlog` セクションの未解消項目を、出典タスク ID を付けて `backlog.md` へ転記する(`current-review.md` はこの後アーカイブされるため、転記しないとバックログがアーカイブに埋没する)。
  - 今回のタスクがバックログ項目の解消だった場合、該当項目を Resolved にし解消タスク ID を記録する。
- **次フェーズの宣言**(マルチフェーズ feature の場合)。

### マルチフェーズ進行(rev.2)

`current-status.json` で以下を宣言する。

- `feature-complete`: feature 完了 → Complete。
- `feature-continue`: 次フェーズへ継続。このとき `nextPhaseId` を**必須**とする(JSON Schema の if/then で強制: §7.5)。CLI は `nextPhaseId` を `feature.md` の Phase list と照合し、不整合なら `invalid-status` で halt する。

遷移先は Research ではなく **Task Planning**。フェーズ境界でタスク定義を再確認し、承認ゲート①を通すためである。

### CLI の postActions

状態変更はすべて CLI が実行する。AI は宣言するのみ。

- `archiveArtifacts`: `attempts/` 履歴を含め `archive/<feature-id>/<task-id>/` へ。
- `restoreTemplates`: current-task / current-result / current-review をテンプレートから復元。
- `resetFixAttempts`: fixAttempts を 0 に戻す。
- `advancePhase`: `feature-continue` のとき `feature.md` の Current phase を更新。

### context-package の扱い

`context-package.md` はライフサイクルがワークフローエンジンに正式実装されるまで自動リセットしない。

---

## 5.9 Review Audit

### 目的

実装レビューの繰り返しではなく、**レビュー自体の品質**を監査する。

### 実行条件(auditPolicy)

CLI が以下に基づき起動を提案する。クリーン連続回数(`cleanReviewStreak`)は Review の status 登録時に CLI が更新・保持する(state.json 所有)。

- Critical / Major ゼロのレビューが 5 回連続(`cleanReviewThreshold: 5`)
- 大規模 feature の完了後 / 新しいワークフロールールの導入後
- 月次キャリブレーション / レビューエージェントが甘くなった疑いがあるとき
- プロンプト変更後 / モデル変更後

### セッション・モデル(rev.2)

- `session: fresh` を必須とする(§2 参照)。
- model-policy に `reviewAudit` エントリを持つ(§8.1)。

### 入力

- `current-task.md` / `context-package.md` / `current-result.md` / `current-review.md`
- Git diff / 関連ソースコード

### 監査観点

- Critical / Major の見逃し、誤った深刻度判定。
- 欠落したレビュー観点、無効・不完全な Fix Scope。
- 弱い Acceptance Criteria・テスト要件、根拠のない推測的指摘。
- context-package 制約の不使用。

### 出力構造

```md
# Audit Summary

## Missing Critical

## Missing Major

## Wrong Severity

## Missing Review Points

## Fix Scope Audit

## Review Quality Score

## Suggestions
```

---

## 6. 成果物設計

## 6.1 `current-status.json`(rev.2 で新設)

**全ステップの分岐は Markdown ではなくこのファイルのみで判定する。** claude / codex ステップは成果物に加えて必ずこれを出力し、cli ステップでは CLI 自身が終了コード等から生成する。

```json
{
  "step": "improve-check",
  "result": "fix-incomplete",
  "reason": "短い人間向け説明",
  "nextPhaseId": null
}
```

### 検証の役割分担(rev.3)

| 検証対象 | 担当 | 内容 |
|----------|------|------|
| 構造 | JSON Schema(§7.5) | required、型、`feature-continue` 時の `nextPhaseId` 必須(if/then) |
| result 値の妥当性 | CLI | **そのステップの transitions キーとの照合**。キーに存在しない値なら遷移せず `invalid-status` で halt |
| step の一致 | CLI | `status.step` と実行中 Step の一致確認(rev.4)。不一致は `invalid-status` で halt(§7.5 / §7.7) |

result のグローバル enum をスキーマに持たせない理由: 単一 enum では「Improve Check が `ready` を返す」ような**越境**を弾けない。値の妥当性はステップ文脈に依存するため、スキーマは構造のみを担い、文脈検証は CLI の遷移表照合に任せる。

## 6.2 `current-task.md`

アクティブな作業単位。推奨内容: Task ID / Feature ID / Phase / Goal / Scope / Requirements / Out of Scope / Acceptance Criteria / Dependencies / Notes。

## 6.3 `feature.md`

タスクを複数フェーズに分解する必要がある場合のみ作成。推奨内容: Feature objective / Phase list / Dependencies / Global constraints / Completion criteria / Current phase(**CLI が更新**)/ Deferred work。

## 6.4 `context-package.md`

Codex への最小実装コンテキスト。目標サイズ **500–1500 トークン**(CLI が TokenRangeValidator で検証: §7.2)。

テンプレート:

```md
# Task Summary

# Requirements

# Existing Design

# Constraints

# Files

## Read

## Modify

## Reference

## Ignore

# Naming Rules

# Known Issues

# Test Strategy

# Notes
```

## 6.5 `codex-prompt.md`

実行可能な実装依頼。実装目標 / 必要な変更 / 振る舞い要件 / スコープ境界 / Acceptance Criteria / 必要テスト / 出力要件を明記する。

## 6.6 `current-result.md`

実装出力の記録。推奨内容: Summary / Files changed / Behavior implemented / Design decisions / Tests run / Test results / Known limitations / Deviations / Remaining concerns。

**履歴保持(rev.2)**: Implementation / Fix の完了時、CLI が `attempts/result-<n>.md` へ複製する。Fix による上書きで過去の実装結果を失わず、「なぜ 3 回 Fix が必要だったか」を後から分析できる。アーカイブ時に `attempts/` も保存する。

## 6.7 `current-review.md`

レビュー記録であり、同時に Fix の契約。必須構造は Artifact Contract(§7.4)で強制する。

## 6.8 `context.md`

長期プロジェクトコンテキスト。アーキテクチャ / ドメイン概念 / 重要な規約 / 主要制約 / リポジトリ構造 / 技術判断 / 恒常的な既知リスク。

## 6.9 `learnings.md`

完了作業からの再利用可能な学習。

## 6.10 `backlog.md`(rev.5 で新設)

`context.md` / `learnings.md` と同格の**永続**成果物。レビューで Backlog に分類された未解消項目の唯一の集約先であり、Reflection でアーカイブされる `current-review.md` からの回収経路を提供する。

推奨フォーマット:

```md
## BL-001

- Source: FEATURE-001 / TASK-003
- Severity: Minor
- Summary: エラーメッセージの i18n 対応が未実施
- Status: open

## BL-002

- Source: FEATURE-001 / TASK-005
- Severity: Major (deferred)
- Summary: リトライ時のログ出力が重複する
- Status: resolved (TASK-012)
```

ライフサイクル:

- **転記**: Reflection が `current-review.md` の `## Backlog` から出典タスク ID 付きで追記する(§5.8)。
- **参照**: Task Planning が optional input として読む。バックログ解消タスクは `current-task.md` に BL-ID を記録し、Research は Source から `archive/` の元レビュー文脈を辿る(§5.1)。
- **消し込み**: 解消タスクの Reflection で Status を resolved にし、解消タスク ID を記録する。項目は削除せず履歴として残す。
- CLI 支援(`aiw backlog` での一覧表示)は post-MVP。

## 6.11 `state.json`

CLI が所有する。

```json
{
  "featureId": null,
  "taskId": null,
  "mode": "single",
  "currentStep": "idle",
  "phase": null,
  "status": "ready",
  "fixAttempts": 0,
  "cleanReviewStreak": 0,
  "haltedReason": null,
  "pendingApproval": null,
  "lastCompletedStep": null,
  "updatedAt": null
}
```

rev.2/3 追加フィールド:

- `fixAttempts`: 現在タスクの Fix 実行回数。
- `cleanReviewStreak`: Critical/Major ゼロのレビュー連続回数(Review Audit 提案用)。
- `haltedReason`: halt 理由(`escalation` / `invalid-status` / `validation-failed` / `approval-rejected` / `post-action-failed` など)。
- `pendingApproval`: 承認待ちゲートの識別子(承認待ち中のみ非 null)。

---

## 7. ワークフローエンジン設計

## 7.1 WorkflowStep の共通型(rev.3)

すべてのステップを同じ構造で扱い、CLI 側の共通処理を可能にする。ロール固有の情報(`session` / `command` 等)は optional フィールドとして共通型に持たせ、ステップごとの例外実装を排除する。

```ts
type FileRef = {
  path: string;
  optional?: boolean;      // 旧記法 `feature.md?` を構造化
};

type WorkflowStep = {
  id: string;
  role: "claude" | "codex" | "cli" | "human";
  session?: "feature" | "fresh";   // claude のみ。既定 "feature"。review-audit は "fresh"
  command?: string;                 // cli のみ。settings 内のコマンドキーを参照
  inputs: FileRef[];
  outputs: FileRef[];
  optionalOutputs?: FileRef[];
  validators?: ValidatorRef[];      // §7.2
  retryPolicy?: RetryPolicy;
  postActions?: string[];
  approval?: ApprovalPolicy;        // §7.3
  transitions: Record<string, Transition>;  // キー = current-status.json の result 値
  standalone?: boolean;             // 通常フロー外(review-audit)
};

type Transition = {
  next: string;
};

type RetryPolicy = {
  counter: string;                  // state.json 側のカウンタ名
  maxRetries: number;
  retryOn: string[];                // リトライとみなす差し戻し元 result(§7.6 参照。カウント条件ではない)
  onExhausted: "escalate";
};
```

設計判断:

- **transitions はマップ構造**(配列 + condition 文字列ではない)。CLI の分岐処理は「status.result をキーに引く」だけになり、condition 式の評価系が不要になる。
- **承認は属性、human はロール**。承認ゲートは `approval` 属性に一本化し、`role: "human"` は将来の手動作業ステップ(例: 手動 QA、リリース操作)のために予約する。同じ概念を二重表現しない。
- **optional input は構造化**。`FileRef.optional` により、CLI の必須入力検証が型情報だけで実装できる。
- **`id` はローダーが注入する(rev.4)**。YAML では Step ID は `steps` のマップキーとして表現し、YAML 本文に重複して記載しない。ローダーがキーから `id` を注入して共通型へ正規化する。

  ```ts
  const steps = Object.entries(config.steps).map(([id, step]) => ({
    id,
    ...step,
  }));
  ```

## 7.2 Validator プラグイン(rev.3)

文字列ベースの検証定義を廃し、独立した Validator として実装する。**各インスタンスは `onViolation` を持つ**。同じ Validator 種別でもステップにより挙動が異なるため(diff-scope は Implementation で `report`、Fix で `halt`)、これは種別ではなくインスタンス設定である。

```ts
type ValidatorRef = {
  type:
    | "file-exists"
    | "json-schema"
    | "artifact-contract"
    | "diff-scope"
    | "token-range"
    | "command-exit-code";
  onViolation: "report" | "halt";
  // 以下 type 固有
  targets?: string[];               // file-exists
  target?: string;                  // json-schema / artifact-contract / token-range
  schema?: string;                  // json-schema
  artifact?: string;                // artifact-contract: artifacts 定義のキーを参照
  declaredFilesFrom?: string;       // diff-scope
  min?: number;                     // token-range
  max?: number;
};
```

想定 Validator:

| type | 実装 | 用途 |
|------|------|------|
| `file-exists` | FileExistsValidator | 必須出力ファイルの存在確認 |
| `json-schema` | JsonSchemaValidator | current-status.json 等の構造検証 |
| `artifact-contract` | ArtifactContractValidator | Markdown 成果物のセクション構造検証(§7.4 の artifacts 定義を参照)。MarkdownSectionValidator の上位互換 |
| `diff-scope` | DiffScopeValidator | git diff とファイル宣言の突合 |
| `token-range` | TokenRangeValidator | context-package のサイズ検証 |
| `command-exit-code` | CommandExitCodeValidator | cli ステップのコマンド成否判定 |

**実行順序**: `file-exists` → `json-schema` / `artifact-contract` → 内容検証(`diff-scope` / `token-range`)。存在しないファイルの内容検証を試みないよう、早期失敗の順で固定する。

`onViolation` の挙動:

- `report`: 違反レポート(例: `scope-violation-report.md`)を生成し、後続ステップの入力に添付して続行。Event Log に `validation.failed` を記録。
- `halt`: 状態を `halted`(`haltedReason: validation-failed`)にして停止。

## 7.3 ApprovalPolicy(rev.3 強化)

```ts
type ApprovalPolicy = {
  required: true;
  actor: "human";
  timing: "before" | "after";
  autoApprove?: boolean;            // 既定 false。段階的自動化の解放スイッチ
  timeoutHours?: number;
  onTimeout?: "pause";              // 期限超過で pause(halt と同様に人間待ち)
  onReject: "rerun" | "halt";       // ★却下パス。必須
};
```

- **却下(reject)時の遷移を必須定義とする**。承認は approve / reject の 2 値であり、reject 時の挙動が未定義だと自動化できない。
  - `rerun`: 却下理由(`rejection-note.md`)をそのステップの追加入力として渡し、同ステップを再実行する。
  - `halt`: 状態を `halted`(`haltedReason: approval-rejected`)にして人間の指示を待つ。
- **autoApprove**: Phase 2 → 3 の移行時、承認の段階的自動化をコード変更ではなく設定で制御するためのスイッチ。既定は false。
- 承認イベント(granted / rejected、actor、理由、日時)はすべて Event Log(§9)に記録する。Slack / CLI 通知は将来拡張。

承認を残す境界(rev.1 から維持):

- Task Planning 後(ゲート①)
- Implementation 前(ゲート②)
- Review 後 = Fix Scope 承認(ゲート③)
- 大規模 Fix の適用前
- Merge / Release 前

## 7.4 Artifact Contract(rev.3)

各成果物の必須構造を `artifacts` 定義として一元管理し、「ファイルは存在するが必要情報が欠けている」状態を検出する。

設計判断:

- **セクションは階層を持つ**(`Fix Scope > Files To Modify` など)ため、フラットな名称リストではなく**見出しレベルを含む定義**とする。フラットだと本文中の偶然の一致や別階層の同名見出しを誤検出する。
- **マッチング規則**: `sections` は「見出しレベル込みの順序付き部分列」として検証する。文書中の見出し列に対し、定義された順序で各見出し(レベル + テキスト完全一致)が出現しなければ違反とする。これにより `## Critical`(レビュー指摘)と `### Critical`(Fix Scope 配下)のような同名・異階層の見出しを正しく区別できる。
- artifacts 定義は独立させ、Validator 側から `type: artifact-contract, artifact: <key>` で**参照**する。これにより §7.2(Validator)と本節が二重定義にならない。JSON 系成果物(current-status)も同じ artifacts 定義に `json-schema` 契約として同居させる。

```yaml
artifacts:
  current-task:
    path: current-task.md
    contract:
      type: markdown-sections
      sections:
        - "# Task"
        - "## Goal"
        - "## Scope"
        - "## Requirements"
        - "## Out of Scope"
        - "## Acceptance Criteria"

  context-package:
    path: context-package.md
    contract:
      type: markdown-sections
      sections:
        - "# Task Summary"
        - "# Requirements"
        - "# Constraints"
        - "# Files"
        - "## Read"
        - "## Modify"
        - "## Reference"
        - "## Ignore"
        - "# Test Strategy"

  codex-prompt:
    path: codex-prompt.md
    contract:
      type: markdown-sections
      sections:
        - "# Objective"
        - "# Required Changes"
        - "# Scope Boundaries"
        - "# Acceptance Criteria"
        - "# Required Tests"

  current-result:
    path: current-result.md
    contract:
      type: markdown-sections
      sections:
        - "# Summary"
        - "## Files Changed"
        - "## Tests Run"
        - "## Test Results"
        - "## Deviations"

  current-review:
    path: current-review.md
    contract:
      type: markdown-sections
      sections:
        - "# Summary"
        - "## Critical"
        - "## Major"
        - "## Minor"
        - "## Good"
        - "## Backlog"
        - "## Ready"
        - "## Fix Scope"
        - "### Files To Modify"
        - "### Critical"
        - "### Major"
        - "### Acceptance Criteria"
        - "### Test Required"

  current-status:
    path: current-status.json
    contract:
      type: json-schema
      schema: schemas/current-status.schema.json
```

> テンプレート(`templates/`)と Artifact Contract は整合させること。テンプレート変更時は contract と templates のバージョン(§8)を同時に更新する。

## 7.5 current-status.schema.json(rev.3)

構造のみを検証する(§6.1 の役割分担参照)。

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "current-status",
  "type": "object",
  "required": ["step", "result", "reason"],
  "additionalProperties": false,
  "properties": {
    "step": { "type": "string", "minLength": 1 },
    "result": { "type": "string", "minLength": 1 },
    "reason": { "type": "string" },
    "nextPhaseId": { "type": ["string", "null"] }
  },
  "if": {
    "properties": { "result": { "const": "feature-continue" } },
    "required": ["result"]
  },
  "then": {
    "required": ["step", "result", "reason", "nextPhaseId"],
    "properties": { "nextPhaseId": { "type": "string", "minLength": 1 } }
  }
}
```

- `result` に enum を置かない。値の妥当性は CLI がステップの transitions キーと照合する(越境防止)。
- `additionalProperties: false` と `reason` / `nextPhaseId` の定義を両立させ、契約通りの出力が弾かれないようにする。
- `feature-continue` のときのみ `nextPhaseId` を必須化(if/then)。
- **`step` の一致検証は CLI が担う(rev.4)**。JSON Schema では `step` は文字列としてしか検証できず、Research が誤って `"step": "review"` を出しても通過してしまう。CLI 検証(§7.7 手順4)で実行中 Step との一致を確認し、不一致は `invalid-status` で halt する。

  ```ts
  if (status.step !== state.currentStep) {
    halt("invalid-status");
  }
  ```

## 7.6 リトライ加算規則(rev.4)

`retryPolicy` は遷移先 Step(fix)に定義されるが、カウンタを消費する result は別 Step(improve-check / testing)から出る。加算タイミングの解釈が実装者により分かれないよう、以下に固定する。

**エンジン規則**: `retryPolicy` を持つ Step への**入場が確定した時点**で、遷移元 result を問わず CLI が counter を加算し、上限を検証する。上限を超える場合は Step を開始せず halt する。初回入場(Review → Fix の `fix-required`)も 1 回として数える。

```ts
// 遷移先 Step が retryPolicy を持つ場合、遷移確定時に実行
const nextAttempt = state.fixAttempts + 1;

if (nextAttempt > retryPolicy.maxRetries + 1) {
  halt("escalation");          // Fix を開始しない
} else {
  state.fixAttempts = nextAttempt;
  transitionTo("fix");
}
```

`maxRetries: 2` は「初回 + 再試行 2 回 = 最大 3 回実行」を意味する(上限判定は `maxRetries + 1`)。

**`retryOn` の位置づけ**: カウント条件では**ない**(カウントは入場確定時に無条件で行う)。retryOn は「どの result からの再入場をリトライとみなすか」の宣言であり、以下に使う。

- Event Log 上での retry / 初回入場の判別(`event.isRetry`)。
- 宣言外の result からの想定外の再入場の検出(retryOn にも初回経路にも該当しない遷移は設定不整合として警告)。

具体的なタイミング:

| 遷移 | 動作 |
|------|------|
| Review → Fix(`fix-required`) | 遷移確定時に `fixAttempts = 1`。初回入場 |
| Improve Check → Fix(`fix-incomplete`) | 遷移確定前に +1 を検証。超過なら Fix を開始せず halt |
| Testing → Fix(`test-failed`) | 同上(同一予算) |

## 7.7 Step 完了処理の順序(rev.4)

Step 完了時の処理順が未定義だと、たとえば Reflection の `restoreTemplates` で成果物を消してから遷移検証を行う、といった事故が起きる。以下の順に固定する。

```text
1.  Step 実行
2.  必須出力の存在確認(file-exists)
3.  Artifact Contract / JSON Schema 検証
4.  status.step と実行 Step の一致確認(不一致 → invalid-status で halt)
5.  status.result と transitions キーの照合(未定義 → invalid-status で halt)
6.  Approval(定義されている場合。rejected → onReject に従う)
7.  次遷移先を確定(遷移先が retryPolicy を持つ場合、§7.6 の加算・上限検証をここで実行)
8.  postActions 実行
9.  state.json 更新(currentStep 遷移のコミット)
10. transition イベントを Event Log に記録
```

要点:

- **検証(2–5)は破壊的操作(8)より必ず先行する**。アーカイブ・テンプレート復元は、遷移が正当であると確定した後にのみ行う。
- **postAction 失敗時は完了遷移を確定しない**。状態を `halted`(`haltedReason: post-action-failed`)にし、どの postAction まで完了したかを Event Log に記録する。再開時は失敗した postAction から再実行するため、各 postAction は**冪等**に実装する(例: archiveArtifacts は既存アーカイブがあればスキップ)。
- Approval(6)が承認待ちの間は `state.pendingApproval` を設定し、7 以降に進まない。
- 9 で state.json を更新するまで `currentStep` は旧 Step のままであり、途中で CLI が落ちても再開時に 2 から再検証できる(Resumability)。

---

## 8. workflow.yaml(rev.5 完全版)

```yaml
version: 5          # workflow 構造のバージョン。詳細は versions セクション

settings:
  statusFile: current-status.json
  singleActiveFeature: true    # current-*.md がフラット構造のため並行 feature 不可(意図的制約)
  contextPackage:
    minTokens: 500
    maxTokens: 1500
  testCommand: "npm test"      # testing ステップで CLI が実行(プロジェクトごとに設定)

defaults:
  escalation:
    to: human
    action: halt

# --------------------------------------------------------
# バージョン分離(rev.3)
# --------------------------------------------------------
# 変更対象ごとにバージョンを持ち、Event Log に使用バージョンを記録する。
# ★乖離検出: CLI は実行時に各 prompt / template / schema の sha256 を計算し、
#   version + contentHash の両方をログに記録する。既知ハッシュ
#   (config/versions.lock.json) と異なるのにバージョンが同じ場合は警告する。
#   これにより「プロンプトを書き換えたのにバージョンを上げ忘れる」ことによる
#   品質比較(Prompt Version 別 Major 検出率など)の汚染を防ぐ。
versions:
  workflow: 5
  prompts:
    taskPlanning: 3
    research: 5
    review: 4
    reviewAudit: 1
    improveCheck: 2
    reflection: 2
  templates:
    currentTask: 2
    currentResult: 1
    currentReview: 3
  schemas:
    currentStatus: 1

artifacts:
  # §7.4 の定義をここに置く(本文参照、省略)

steps:
  # Step ID はマップキーとして表現する。WorkflowStep.id はローダーがキーから注入し、
  # YAML 本文には重複記載しない(§7.1)。

  task-planning:
    role: claude
    inputs:
      - path: user-task.md
      - path: context.md
      - path: feature.md
        optional: true             # マルチフェーズ継続時
      - path: backlog.md
        optional: true             # 積み残し解消タスクの参照用(rev.5)
    outputs:
      - path: current-task.md
      - path: current-status.json
    optionalOutputs:
      - path: feature.md
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-task.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
      - type: artifact-contract
        onViolation: halt
        artifact: current-task
    approval:
      required: true
      actor: human
      timing: after                # 承認ゲート①
      onReject: rerun
    transitions:
      planned:
        next: research

  research:
    role: claude
    inputs:
      - path: current-task.md
      - path: context.md
      - path: feature.md
        optional: true
    outputs:
      - path: context-package.md
      - path: codex-prompt.md
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [context-package.md, codex-prompt.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
      - type: artifact-contract
        onViolation: halt
        artifact: context-package
      - type: artifact-contract
        onViolation: halt
        artifact: codex-prompt
      - type: token-range
        onViolation: halt
        target: context-package.md
        min: 500
        max: 1500
    approval:
      required: true
      actor: human
      timing: after                # 承認ゲート②(実装前)
      onReject: rerun
    transitions:
      research-complete:
        next: implementation

  implementation:
    role: codex
    inputs:
      - path: codex-system.md
      - path: context-package.md
      - path: codex-prompt.md
    outputs:
      - path: current-result.md
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-result.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
      - type: artifact-contract
        onViolation: report        # 実装結果の構造欠落はレビューで扱う
        artifact: current-result
      - type: diff-scope
        onViolation: report        # 逸脱は scope-violation-report.md として review へ添付
        declaredFilesFrom: context-package.md
    postActions:
      - snapshotResult             # attempts/result-<n>.md へ複製
    transitions:
      implemented:
        next: review

  review:
    role: claude
    inputs:
      - path: current-task.md
      - path: context-package.md
      - path: current-result.md
      - path: git-diff
      - path: test-results
        optional: true
      - path: scope-violation-report.md
        optional: true
    outputs:
      - path: current-review.md
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-review.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
      - type: artifact-contract
        onViolation: halt          # Fix の契約になるため構造欠落は許容しない
        artifact: current-review
    approval:
      required: true
      actor: human
      timing: after                # 承認ゲート③(Fix Scope 承認)
      onReject: rerun
    transitions:
      ready:
        next: reflection
      fix-required:
        next: fix

  fix:
    role: codex
    inputs:
      - path: codex-system.md
      - path: context-package.md
      - path: current-review.md
      - path: test-report.md
        optional: true             # testing 失敗経由のみ
    outputs:
      - path: current-result.md
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-result.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
      - type: diff-scope
        onViolation: halt          # Bounded Fixes: Fix の逸脱は即 halt
        declaredFilesFrom: current-review.md
    retryPolicy:
      counter: fixAttempts
      maxRetries: 2              # 上限判定は maxRetries + 1(§7.6)
      retryOn:                   # リトライ判別用の宣言。カウントは入場確定時に無条件(§7.6)
        - fix-incomplete
        - test-failed
      onExhausted: escalate
    postActions:
      - snapshotResult
    transitions:
      fixed:
        next: improve-check

  improve-check:
    role: claude
    inputs:
      - path: current-review.md
      - path: current-result.md
      - path: git-diff
    outputs:
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
    transitions:
      ready-for-test:
        next: testing
      ready-for-reflection:
        next: reflection
      fix-incomplete:
        next: fix                  # Fix入場確定時に fixAttempts 加算、上限超過で escalate(§7.6)

  testing:
    role: cli
    command: testCommand
    inputs:
      - path: current-review.md
    outputs:
      - path: test-report.md
      - path: current-status.json  # CLI が終了コードから生成
    validators:
      - type: command-exit-code
        onViolation: report        # 失敗は test-failed 遷移で扱うため halt しない
    transitions:
      test-passed:
        next: reflection
      test-failed:
        next: fix                  # test-report.md 添付、fixAttempts 共有

  reflection:
    role: claude
    inputs:
      - path: context.md
      - path: current-task.md
      - path: current-result.md
      - path: current-review.md
      - path: learnings.md
      - path: backlog.md           # Backlog 転記・消し込みの対象(rev.5)
      - path: feature.md
        optional: true
    outputs:
      - path: context.md
      - path: learnings.md
      - path: backlog.md           # current-review の Backlog を出典付きで転記(rev.5)
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [current-status.json]
      - type: json-schema
        onViolation: halt          # feature-continue 時の nextPhaseId 必須は schema が担う
        target: current-status.json
        schema: schemas/current-status.schema.json
    postActions:
      - archiveArtifacts
      - restoreTemplates
      - resetFixAttempts
      - advancePhase               # feature-continue のとき CLI が feature.md を更新
    transitions:
      feature-continue:
        next: task-planning        # フェーズ境界で承認ゲート①を通す
      feature-complete:
        next: complete

  review-audit:
    role: claude
    session: fresh                 # 監査の独立性のため必須
    standalone: true               # 通常フロー外。auditPolicy に基づき CLI が起動提案
    inputs:
      - path: current-task.md
      - path: context-package.md
      - path: current-result.md
      - path: current-review.md
      - path: git-diff
    outputs:
      - path: audit-report.md
      - path: current-status.json
    validators:
      - type: file-exists
        onViolation: halt
        targets: [audit-report.md, current-status.json]
      - type: json-schema
        onViolation: halt
        target: current-status.json
        schema: schemas/current-status.schema.json
    transitions:
      audit-complete:
        next: complete

auditPolicy:
  cleanReviewThreshold: 5          # Critical/Major ゼロの連続回数。カウンタは CLI 所有
  counterOwner: cli
  alsoSuggestOn:
    - monthly
    - large-feature-complete
    - prompt-change
    - model-change
```

## 8.1 model-policy.json

```json
{
  "taskPlanning":  { "model": "claude-sonnet", "effort": "low" },
  "research":      { "model": "claude-sonnet", "effort": "medium" },
  "implementation":{ "model": "codex",         "effort": "medium" },
  "review":        { "model": "claude-opus",   "effort": "high" },
  "fix":           { "model": "codex",         "effort": "low" },
  "improveCheck":  { "model": "claude-sonnet", "effort": "low" },
  "reflection":    { "model": "claude-sonnet", "effort": "low" },
  "reviewAudit":   { "model": "claude-opus",   "effort": "high" }
}
```

- rev.3 変更: `reviewAudit` を追加(review と同格の検出力が必要なため opus / high)。`testing` は role: cli となったためモデルエントリを削除。

---

## 9. Event Log(rev.3)

全ステップの開始・終了・失敗・承認・遷移を `runs/execution-log.jsonl` に**追記専用**で記録する。集計・分析はすべてログから導出し、ログ自体は不変とする。

### イベント種別

```text
step.started        step.completed      step.failed
validation.failed   approval.granted    approval.rejected
transition          workflow.halted     workflow.resumed
audit.suggested
```

### 記録項目

- タイムスタンプ、イベント種別、featureId / taskId / step
- 実行時間、モデル、effort
- **workflowVersion / promptVersion / templateVersion / schemaVersion と各 contentHash**(§8 のバージョン分離に対応)
- **fixAttempts の現在値と isRetry フラグ**(1 タスク内の複数 Fix 試行を区別し、Fix 発生率・試行分布の分析を可能にする。isRetry は retryOn 宣言に基づき CLI が付与: §7.6)
- 成果物リスト、Validation 結果(validator type / onViolation / 結果)
- Review の Critical / Major / Minor 件数、cleanReviewStreak
- Approval(actor / granted・rejected / 理由 / 日時)
- 状態遷移(from / to / result 値)、エラー、中断・再開

### 記録例

```json
{
  "timestamp": "2026-07-21T10:03:00+09:00",
  "event": "step.completed",
  "workflowVersion": 5,
  "promptVersion": 5,
  "promptHash": "sha256:ab12…",
  "featureId": "FEATURE-001",
  "taskId": "TASK-003",
  "step": "research",
  "model": "claude-sonnet",
  "effort": "medium",
  "durationSeconds": 420,
  "fixAttempts": 0,
  "result": "research-complete",
  "outputs": ["context-package.md", "codex-prompt.md"],
  "validation": [
    { "type": "token-range", "target": "context-package.md", "passed": true }
  ],
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null
}
```

トークン・キャッシュ項目は Phase 1(手動運用)では null を許容し、Phase 2 の API 自動実行で API レスポンスから取得して埋める。

### 分析可能になる指標

- 平均 Research / Implementation / Review / Fix 時間、待ち時間、リードタイム
- Fix 発生率、Fix 試行分布(fixAttempts 別)
- Critical / Major 検出率、Review Audit での見逃し率
- モデル別成功率、effort 別品質
- **Prompt Version 別品質**(例: Review Prompt 変更前後の Major 検出率、Research Prompt 変更後の Fix 率)— contentHash 検証により比較の信頼性を担保
- Workflow Version ごとの平均所要時間

---

## 10. 品質管理ポリシー

Critical / Major の指摘がないことは、品質が完璧であることの証拠ではない。

ルール:

```text
Critical / Major ゼロのレビューが 5 回連続
→ Review Audit を実行(cleanReviewStreak は CLI が state.json で管理)
```

以下の場合も監査を実行する:

- 月次 / 大規模 feature 後 / プロンプト大幅変更後 / モデル変更後
- 計測されたスピードアップを運用キャパシティとして扱う前

---

## 11. 直近の実装スコープ

### 推奨 MVP

1. `workflow.yaml` ローダー(versions / artifacts / steps / auditPolicy。Step ID のマップキー注入を含む)
2. WorkflowStep 共通型によるステップ定義(§7.1)
3. `current-status.json` 駆動の状態遷移 + step 一致検証 + transitions キー照合(invalid-status 検出)
4. **§7.7 の完了処理順序のエンジン実装**(検証 → 承認 → 遷移確定 → postActions → state 更新 → ログ)
5. Validator フレームワークと最小 4 種(file-exists / json-schema / artifact-contract / token-range)
6. Fix ループ(§7.6 の入場確定時加算 / maxRetries / escalate)
7. Approval(after / onReject: rerun|halt)
8. `aiw next` / `aiw run <step>`
9. 一時停止と再開(state.json からの復元。postAction 失敗地点からの再実行を含む)
10. Event Log(JSONL 追記、バージョン + contentHash 記録)
11. snapshotResult による試行履歴保持

MVP 後の早期追加: diff-scope Validator、command-exit-code Validator + Testing ステップ、versions.lock.json によるハッシュ乖離警告、autoApprove。

### まだ自動化しないもの

- 自律的なマージ / デプロイ
- 承認なしの広範なソース変更
- 無制限のリトライループ(→ maxRetries で構造的に排除済み)
- レビュー出力の自動受理(承認ゲート③の autoApprove は当面 false 固定)
- 完全自律のマルチエージェント実行

### MVP 成功基準

- CLI 再起動後にタスクを再開できる(postAction 失敗後は失敗地点から冪等に再実行できる)。
- 無効なフェーズ遷移・未定義の result 値・**step 不一致**(invalid-status)がブロックされる。
- 成果物の欠落**および構造欠落**(Artifact Contract 違反)が明確に報告される。
- 次のステップが state と outputs から導出される。
- Review が Fix / Reflection へ正しく分岐し、Fix ループが §7.6 の規則どおり上限で必ず停止して人間へエスカレーションされる。
- **破壊的な postActions(アーカイブ・テンプレート復元)が、遷移の正当性検証より前に実行されない。**
- 承認の却下が定義済みの挙動(rerun / halt)に従う。
- すべての実行がバージョン情報付きでログに記録される。
- プロンプトがコマンドハンドラにハードコードされていない。

---

## 12. ディレクトリ構造

```text
.ai-workflow/
├── config/
│   ├── workflow.yaml
│   ├── model-policy.json
│   └── versions.lock.json        # 各 prompt/template/schema の既知ハッシュ(乖離検出用)
├── schemas/
│   └── current-status.schema.json
├── prompts/
│   ├── task-planning.md
│   ├── research.md
│   ├── review.md
│   ├── review-audit.md
│   ├── improve-check.md
│   └── reflection.md
├── templates/
│   ├── current-task.md
│   ├── current-result.md
│   └── current-review.md
├── attempts/                     # 試行履歴(result-<n>.md)。アーカイブ時に一緒に保存
├── archive/
│   └── <feature-id>/
│       └── <task-id>/
├── runs/
│   └── execution-log.jsonl
├── research/
├── codex-system.md
├── context.md
├── context-package.md
├── codex-prompt.md
├── current-task.md
├── current-result.md
├── current-review.md
├── current-status.json
├── feature.md
├── learnings.md
├── backlog.md
└── state.json
```

---

## 13. 設計原則

1. Minimal Context
2. Explicit Contracts — **成果物の構造(Artifact Contract)と状態(JSON Schema)を機械検証可能な契約とする**
3. Deterministic State — **AI は宣言し、CLI が検証して遷移する**
4. Bounded Fixes — **Fix はスコープと回数の両方で有界**
5. Human Approval — **却下パスを含めて定義された承認**
6. Review Calibration
7. Durable Learning
8. Configuration Over Hard Coding
9. Resumability
10. Observability — **バージョン + ハッシュ付き Event Log による比較可能な計測**

---

## 14. 現状

### 安定

- Claude / Codex の役割分離、1 feature 1 Claude セッション、タスク単位の Codex セッション
- Task Planning / Research / Context package / 実装プロンプト
- レビューフォーマット / Fix Scope / Fix フロー / Improve Check / Reflection
- Review Audit の概念、CLI 所有の状態、モデルポリシーの概念、シェルモード運用

### 設計確定・未実装(rev.2 〜 rev.5)

- Fix ループの閉塞と fixAttempts 上限(入場確定時加算規則: §7.6)
- Testing ステップ(role: cli)
- current-status.json 契約 + JSON Schema + transitions キー照合 + step 一致検証
- マルチフェーズ進行(feature-continue / nextPhaseId / advancePhase)
- Review Audit の fresh セッション + reviewAudit モデルポリシー
- WorkflowStep 共通型(id はローダー注入)/ Validator プラグイン / Artifact Contract
- ApprovalPolicy(onReject / autoApprove / timeout)
- Step 完了処理順序と postAction 失敗時の halt(§7.7)
- バージョン分離 + contentHash 乖離検出
- Event Log
- 永続バックログ backlog.md(転記・参照・消し込みのライフサイクル)

### 未着手

- `context-package.md` の正式なライフサイクル
- DAG 実行エンジン、自動出力検出、クロスエージェント自動ハンドオフ
- トークン・キャッシュ計測(Phase 2 で API から取得)
- Review Audit の自動起動(auditPolicy はまず提案のみ)
- `aiw backlog` コマンド(バックログ一覧表示。post-MVP)
- 並行 feature(singleActiveFeature 制約の解除。feature 単位のディレクトリ化が前提)

---

## 15. 次の判断

推奨する次のステップ:

```text
既存の CLI コマンドを、§7 の共通型・Validator・承認モデルに基づく
設定駆動でステートフルなワークフローエンジンへ変換する。
検証・分岐・再開可能性を備え、Fix ループが構造的に有界であること。
```

これにより、人間のコントロールを早まって外すことなく、後の Claude–Codex 自動ハンドオフの基盤が整う。実装順序は §11 の MVP スコープに従う。
