# Skill: Fix

fix ステップで毎回同じように行う手順。
今回直す対象は `current-review.md` の `## Fix Scope` にあり、ここには書かない。

## 手順

1. `.ai-workflow2/codex-system.md` / `context-package.md` / `current-review.md` を読む。
   `test-report.md` があれば併せて読む（verify-local が失敗したときだけ生成される）
2. `current-review.md` の **`## Fix Scope` のみ**を対象に、Critical / Major を修正する
3. `current-result.md` を**検証パッケージとして作り直す**（下記）
4. `current-status.json` を書く

## 修正着手前の準備

`current-review.md` の **`## Verification Data`** から実データ値
（seed 値・実測値・再現条件）を抽出し、**検証ではその値をそのまま使う**。
⚠️ **自分で想定値を仮定しない。**

実測: 想定値（`quantity=2` / `amount=202`）で検証して実値（`608.490` / `61,457`）と
食い違い、手戻りが発生した。**実値は `## Verification Data` に書かれていた。**

## Fix Scope の読み方

- `### Files To Modify` が変更してよいファイルの全体。**ここから外れたら halt する**
  （fix の `diff-scope` は report ではなく halt。Bounded Fixes の要）
- `### Critical` / `### Major` が直す対象。Minor は Critical / Major に必要な場合を除き直さない
- 直すべきでないと判断した項目があれば、黙って飛ばさず `## Deviations` に理由を書く

## 検証の段階制

**検証は3段階で行う。**

1. **開発中** — 対象を絞った**最小の検証**（一時 spec / 単一テスト）を反復する。
   **バックエンドは一度起動したら維持する**
2. **修正が揃ってから** — build / unit / フルスイートを**各1回**実行する
3. **完了前** — 一時的な検証コードを**削除する**

⚠️ **フルスイートを反復のたびに実行しない。**

実測: 小さな locator 修正のたびにフル e2e（3 spec・1回約2分）を **18 回**回し、
fix 1周 50 分のうち約 40 分が e2e の反復に消えた。

## current-result.md の書き方

implementation と同じ Artifact Contract を使う。必須見出しとその順序は
`workflow.yaml` の `artifacts.current-result` が正本。**前回の内容を残さず作り直す**。

### 触れていない AC の扱い

`## Acceptance Criteria Verification` は全 AC を再掲する。ここが fix 特有の要点で、
**Fix で触れていない AC を、確かめずに `PASS` のまま残さない**。

再確認していないなら `NOT VERIFIED` へ落とし、理由を `Notes` に1行書く。
improve-check と review はこの三値を見て「直ったか」を判断するため、
前回の `PASS` を惰性で持ち越すと、確認されないまま完了へ進む。
