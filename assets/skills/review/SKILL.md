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
- **パリティ監査**: `research-findings.md` の `## Sibling Parity`（兄弟機能の棚卸し表）が
  ある場合、「適用」の各行が実装に反映されているかを AC と突き合わせる。
  **表も「兄弟なし」の1行も無いのに、対象機能と同じデータへの既存類似操作が明らかに
  存在する場合は、`research起因` の Major として指摘する**（棚卸しの発動漏れへの網）。
  「対象外」の行が `# Open Decisions` / `# UX Assumptions` のどちらにも無い場合も同様

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

## 検証の道具立て（M4 段階1-2）

### ⚠️ 計測コードを書かない

**Reviewer が Builder になる経路を塞ぐ。** 既存の E2E / テストの**実行は許可**されているが、
**spec やスクリプトの作成は禁止**（ツール制限でも構造的に不可能にしてある）。

必要な計測が既存の手段で取れないときは、書いて測らずに**記録する**:

- 自動で確かめられないもの → `## Manual Verification Audit` へ Manual Verification Required として起票
- 確かめられなかったもの → その AC の評価を **NOT VERIFIED** として書く

⚠️ **PASS へ丸めない。** 「たぶん動く」を PASS にするのは、この Skill が
`## Acceptance Criteria Evidence Audit` で禁じていることを Reviewer 自身がやることになる。

### 文字化けの検査（BL-071）

⚠️ **置換文字 U+FFFD を探すだけでは見つからない。** UTF-8 の日本語を CP932 で誤読しても
**U+FFFD が出ないまま化ける**（`更新` → `譖ｴ譁ｰ`）。実測: U+FFFD 検査は 10 件中 **0 件**しか拾えなかった。

差分に日本語を含むファイル（画面文言・メッセージ・CSV 等）があるときは、次で検査する:

```bash
grep -cP '(*UTF)[\x{FF61}-\x{FF9F}]|[縺繧繝蜀蜈蟄譁隲鬮髴闖蝓豼讀荳陦蠑霑蟾逕豁螟蜷蜑逋蟇邨譖蜊蟶蜉隕隱]' <file>
```

- ⚠️ **`(*UTF)` は必須。** 無いと `character value in \x{} is too large` で exit 2 になる
- ⚠️ リテラルの範囲指定（`[｡-ﾟ]`）は使わない。ロケール未設定の GNU grep では
  バイト単位で照合し、**正常な日本語を誤検出する**（実測 3 件）
- 実測: 化けサンプル 10/10 検出・偽陽性 0（正常な日本語ドキュメント 2,999 行で 0 件）
- 0 以外が出たら、その行を `## Critical`（表示文言なら Major 以上）として指摘する

## 出力先

**成果物をファイルに書くこと。** チャットに出力しただけでは `current-review.md` が
テンプレートのまま（178 bytes）になり、`aiw run review` が延々と弾かれる
（実測 970 分の停止あり）。`current-review.md` と `current-status.json` の
**両方**を書き出してから `run` する。
