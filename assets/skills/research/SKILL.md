# Skill: Research

research ステップで毎回同じように行う手順。今回のタスクは `current-task.md` にある。

## 目的

計画済みタスクを、最小限だが十分なコンテキストを持つ**実装可能パッケージ**へ変換する。
このステップは調査と宣言だけを行い、**実装・アプリケーションソースの変更はしない**。
正当化のない広範なリポジトリ探索もしない。

## 読者で成果物を分ける

| ファイル | 読者 | 制約 |
| --- | --- | --- |
| `context-package.md` | **Codex（実装者）** | token-range 検証あり。設定値は workflow.yaml が正本 |
| `research-findings.md` | 人間・レビュアー | トークン制約なし |
| `codex-prompt.md` | Codex（実装者） | — |

Codex は「何を作るか」だけ要る。Current / Target / Delta や Open Decisions は
人間とレビュアーが読むもので、実装者に渡すとノイズになる。

**`context-package.md` にセクションを足したくなったら `research-findings.md` 側へ足すこと。**
token-range の上限は Codex の焦点を守るための制約で、緩和しない。

この3ファイルはテンプレートから復元されない。必須見出しとその順序は
`workflow.yaml` の `artifacts` が正本で、**レベル込みで正確に・その順序で**出力しないと
artifact-contract が halt する。

## context-package.md

### `# Acceptance Criteria Matrix`

次の表形式にする。ID は `AC-01` から連番。
実装はこの ID で検証結果を返し、review は ID ごとに証拠を突き合わせる。

| ID | Expected Behavior | Verification | Evidence Required |
|---|---|---|---|
| AC-01 | 検索条件が API へ渡る | API test | テスト名 |
| AC-02 | 実行中は再押下不可 | UI test | スクリーンショット |

### `## Ignore`

**このワークフロー自身の成果物を必ず列挙する**:

- `.ai-workflow2/` 配下すべて。特に `context-package.md` / `codex-prompt.md` /
  `research-findings.md` / `current-task.md` / `current-review.md` / `state.json`

実装フェーズがこれらを書き換えると research の成果物が失われ、復元の手戻りになる（実測あり）。
`current-result.md` と `current-status.json` は実装フェーズ自身の出力なので例外。

### 波及ファイルの宣言規則

コンポーネントを `## Modify` に入れる場合、以下も `## Modify` か `## Reference` に含める:

- その親 Page / Panel
- 対応するテストファイル
- 画面登録しているエントリポイント

判断基準: **変更対象から import している / されているファイルは、
変更が波及する候補として棚卸しする。**

> **なぜこの規則があるか（実測）**
> M1.5 期の diff-scope 違反 6 件は**すべて隣接ファイル**だった——
> Page / Panel / Tab の親子、テストファイル、画面登録ファイル。
> 無関係ファイルへの逸脱は 0 件。つまり Codex が暴走したのではなく、
> **research の宣言が波及範囲を取りこぼしていた**。
> 宣言に含めておけば違反にならず、review の手間も減る。
> 迷ったら `## Modify` ではなく `## Reference` に入れる（宣言過多は違反にならない）。

## 算出値の扱い ← 最重要

**仕様書に明記された値と、research が自分で出した値を混ぜない。**

| 種別 | 書く場所 |
| --- | --- |
| 仕様書・依頼に**明記された**値 | `context-package.md` の `# Source Requirements` |
| research が**計算・測定・推定した**値 | `research-findings.md` の `# Inferred Behavior` |

`# Inferred Behavior` に書く値には **算出根拠を必ず併記する**。

- 算出根拠: 式 / 参照元（ファイル:行、実測値、測定方法）
- 確度: 高 | 中 | 低

算出値を `# Constraints` や `# Acceptance Criteria Matrix` に載せる場合も、
**由来が Inferred だと分かる形にする**
（例: `minWidth: 160px（Inferred。算出根拠は research-findings.md 参照）`）。

> **なぜこれを守るのか（実測された失敗）**
> 必要幅を `root幅 − input幅` で算出し、**input 自身の padding 12px を勘定に入れなかった**ため、
> 指示した `minWidth` が両方とも 12px 不足した。実装は指示に忠実で瑕疵はなく、
> review が Major 2 件として捕捉して Fix ループが1回発生した。
> **算出値を Source Requirements と同じ確度で断定したことが原因。**
> 根拠を併記していれば review が検算できる。断定すると検算対象にならない。

## `# Required Tests` の既定

実装フェーズの所要時間はテスト実行が大きく占める。**既定は軽くし**、重い e2e は条件を
満たすときだけ要求する。

既定（ほとんどのタスクはこれで足りる）:

- ビルド
- unit テスト
- 変更に直接対応する e2e spec を **最大1本**

複数 spec の e2e を要求してよいのは次のいずれかに該当するときだけで、
**該当する理由を `# Required Tests` に1行で明記する**:

- 複数画面から参照される共通コンポーネントを変更する
- 画面の大規模改修で既存導線に回帰が出うる
- 同一箇所で過去に回帰が発生している

複数 spec を要求する場合は、**1コマンドにまとめた形**で書くこと。
spec ごとに分けて書くと `webServer` が本数分だけ再起動し、待ち時間が積み上がる。

> **実際に書くコマンドは Local Environment に従う。** 上に結合されていればその手順が正しい。
> 無い環境では `package.json` の scripts を確認して決める。
> `# Required Tests` には**実体を書く**こと。実装フェーズの入力は
> `codex-system.md` / `context-package.md` / `codex-prompt.md` の3つだけで、
> Skill や Local Environment は実装フェーズへ渡らない。

## UX 判断が必要なときは止める

次のいずれかに該当し、**仕様書からも既存実装からも一意に決まらない**場合は、
`research-findings.md` の `# Open Decisions` に選択肢と論点を書き、
`result` に `ux-decision-required` を返して止める。

- 新しい操作フロー
- UI 配置の変更
- エラー表示の変更
- ローディング状態・空状態の変更
- 文言の判断
- モーダルか画面遷移かの判断
- 仕様書と既存 UX の不整合

人間が `# Open Decisions` に決定を書き込んだあと、research を**再実行**する。

> **再実行時の注意**: 前回の `context-package.md` / `codex-prompt.md` /
> `research-findings.md` はディスクに残っており `file-exists` を通過してしまう。
> **決定を反映して3ファイルとも作り直すこと。** 前回のまま `run` すると、
> 決定が反映されないまま implementation へ進む。

判断が要る場合でも、**仕様書か既存実装から一意に決まるなら止めない**。その場合は
`# UX Assumptions` に「何をどう決めたか」と根拠を書いて `research-complete` を返す。
