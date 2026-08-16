# Skill: Review

review ステップで毎回同じように行う手順。今回の対象は入力成果物側にある。

## 目的

実装の正しさを評価し、**境界の明確な Fix Scope を生成する**。
`current-review.md` の Fix Scope はそのまま Fix の契約になり、
承認された範囲だけが Fix フェーズの作業対象になる（別途 fix 用のプロンプトは作らない）。

## current-review.md の書き方

必須見出しとその順序は `workflow.yaml` の `artifacts.current-review` が正本。
**1段でもズレると artifact-contract が halt する**（`# Critical` と `## Critical` は別物）。
復元済みテンプレートの見出しをそのまま使い、本文だけ埋めるのが最も安全。

個別の指摘に見出しを付ける場合は、その親より1段深いレベルにする
（`## Critical` 配下は `### C1. …`、`## Major` 配下は `### M1. …`）。
契約は順序付き部分列で照合するため、余分な見出しがあっても順序とレベルが保たれていれば通る。

## 監査4セクション

冒頭の監査セクションでは、以下を**明示的に確認して結果を書く**。
「問題なし」で済ませず、何を突き合わせたかを1行ずつ残す。指摘に至ったものは Critical / Major へ落とす。

### `## Specification Coverage Audit`

- 実装が `context-package.md` の `# Source Requirements` を満たしているか
- **Fix が必要な場合、原因を分類する**: `実装起因`（指示どおりに作られていない）か
  `research起因`（指示自体が誤っていた）か。**この分類が Fix 発生率の解釈に必要**なので、
  Fix Scope を出すときは必ずどちらかを書く

### `## Acceptance Criteria Evidence Audit`

- `context-package.md` の `# Acceptance Criteria Matrix` の AC ごとに、
  `current-result.md` の `## Acceptance Criteria Verification` を突き合わせる
- **`Status` が三値（PASS / FAIL / NOT VERIFIED）になっているか。**
  検証していないのに PASS になっていないか（二値へ丸めていないか）
- `Evidence` に挙がったテスト名・コマンド出力・スクリーンショットが**実在するか**。
  実在しない証拠での PASS は Major 以上

### `## Manual Verification Audit`

- `current-result.md` の `## Manual Verification Required` に漏れがないか
- 自動検証できない AC が PASS になっていないか

### `## Risk Area Audit`

- **`research-findings.md` の `# Inferred Behavior` の算出根拠を検算する。**
  式・参照元・測定方法をたどり直し、数値そのものが正しいかを確かめる。
  根拠が書かれていない算出値があれば、それ自体を Major として指摘する
  （検算できない断定は Fix の温床。実測: padding 12px の勘定漏れで Fix 1回）
- `research-findings.md` の `# Open Decisions` が、実装で**無断確定**されていないか
- High Risk 差分（認証 / 権限 / マイグレーション / 設定 / 共通コンポーネント）

### `## Verification Data`

**fix が検証で使う実データ値を書く。** fix はここの値を**そのまま**検証に使う。

- **seed / テストデータの実値**（どの行の何が幾つか）
- **再現手順**（どの画面をどう開き、どの行を操作するか）
- **検証時の期待値**（操作前 / 操作後 / Undo 後 など）

⚠️ **「適切な値」「実測値」のような抽象記述は不可。** 実際の数値・文字列を書く。

実測: 実値を本文の別の場所にだけ書いたところ、fix が**自分で想定値を仮定して検証し**、
実値との不一致で手戻りした。**書いてある場所が契約で保証されていないと読み落とされる。**

## 出力先

**成果物をファイルに書くこと。** チャットに出力しただけでは `current-review.md` が
テンプレートのまま（178 bytes）になり、`aiw run review` が延々と弾かれる
（実測 970 分の停止あり）。`current-review.md` と `current-status.json` の
**両方**を書き出してから `run` する。
