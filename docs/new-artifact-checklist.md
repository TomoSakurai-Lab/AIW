# 新しい成果物ファイルを足すときのチェックリスト

`.ai-workflow/` に新しい成果物ファイル（`current-*.md` / `*-manifest.json` など）を
足すときに通す確認項目。**生成側を配線した時点では完成していない。**

> このファイルは BL-102 として新設した。
> 由来は「生成だけ配線して掃除を忘れる」の**3回の再発**（`docs/aiw-known-issues.md` の
> KI-09 サブパターン）。3回とも「動くこと」の確認で満足し、
> **タスク2周目で初めて発覚**している。1周だけ回して完了にしない。

---

## チェックリスト

```markdown
- [ ] **生成**: どのステップが書くかを決め、Skill / プロンプトへ配線した
- [ ] **contract**: `workflow.yaml` の `artifacts` に定義し、validator から参照した
      （契約の正本は workflow.yaml。Skill やプロンプトへ見出し一覧を再記述しない）
      - JSON 成果物の schema は **`assets/schemas/` に置き、`aiw init` で配られることを
        確認した**（2026-08-31 追加。runtime にだけ置くと新環境に存在せず、validator の
        参照も無ければ壊れても誰も検知しない。BL-113 で ac-* の schema が宙吊りだった形）
- [ ] **archive**: `postActions.ts` の `archiveArtifacts` の対象へ追加した
- [ ] **掃除**: タスク終了時にどうするかを決めた
      - 「作業中の器」なら `restoreTemplates` + `templates/` に雛形を置く
      - 「そのタスクの記録」なら **archive 後に削除**する postAction を足し、
        `workflow.yaml` の `reflection.postActions` に **`archiveArtifacts` より後**で宣言した
      - ⚠️ 記録に空テンプレを置くと、中身が無いまま `file-exists` / `json-schema` が
        素通りする（`task-metadata.json` で実際に踏んだ形）
- [ ] **分類表**: `docs/m2-prompt-decomposition.md` の分類表へ行を足した
      （どの情報がどこに属するかの照合リスト）
- [ ] **許可リスト**: `codex-system.md` の「書いてよい」リストへ追加した
      （2026-08-28 追加。ac-* で Skill と codex-system の指示が競合し、
       実装が始まる前に停止する事象が多発した）
- [ ] **パス規約**: ファイル内にパスを書くなら、**どこ起点か**を決めて入力側の Skill に
      明記した。現行の規約は **checkRepoRoot（検査対象リポジトリのルート）相対**
      （2026-09-01 追加。`consumerChecks[].root` を validator だけが runtimeRoot 起点で
       解決しており、正しく書かれた宣言が全件「存在しない」になっていた。偽陽性 10 件）
- [ ] **2周目のテスト**: **2タスク連続**で回して、それぞれの分が別々に残ることを固定した
      （1タスクでは「2件目が1件目を上書きする」形の欠陥が出ない。KI-09 系譜 #4 で
       ~30 タスク分が復旧不能になった）
- [ ] **テストは実配置を模倣しているか**: テストが作る土俵が、本番の配置と同じか確認した
      - パスの起点（runtimeRoot / checkRepoRoot）、git リポジトリの有無、
        gitignore の効き方、ファイルの親子関係
      - ⚠️ **テストが通ることは、実装が正しいことの証明にならない**——
        テストの前提が実装のバグと一致していれば、両方まとめて通る
      - 判定のしかた: **「本番でこの検査が成功した実績はあるか」を Event Log で数える。**
        テストが緑でも `passed` が 0 件なら、一度も機能していない
```

## 使い方

- 追加を含むタスクの `current-task.md` の `## Acceptance Criteria` へ、
  **該当する項目を AC として写す**。チェックリストを別に持つと見ない
- 「この成果物には当てはまらない」項目は**消さずに理由を1行**書く。
  消すと、次に足す人が項目の存在を知らない
- **緑のテストを根拠にしない。** 配線した検査は、本番で一度成功する（`passed` が 1 件以上
  記録される）まで「効いている」と言わない。9 点目はそのための項目

## 再発の記録

| 回 | 成果物 | 落とした項目 | 発覚 |
| --- | --- | --- | --- |
| 1 | `task-metadata.json` | 掃除（restore にして残骸が素通り） | 2周目 |
| 2 | `research-findings.md` | archive と掃除の両方 | M1 レビュー |
| 3 | `ac-manifest.json` / `ac-result.json` | archive と掃除の両方 + 許可リスト | 2周目（実装が停止） |
| 4 | `consumerChecks[].root` の解決基準 | パス規約 / 実配置の模倣 | ソーク窓の偽陽性 10 件（テストは緑・本番の `passed` は 0 件） |

## 通した記録

| 日付 | 成果物 | 結果 |
| --- | --- | --- |
| 2026-10-19 | `runs/snapshots/<step>/`（スナップショット・`knowledge-diff.md` / `.json`・却下の退避 `<step>-rejected-*`）（小枠A・BL-288） | 生成: エンジン（入るとき・run・却下）/ contract: 検証対象ではない表示用の報告なので artifacts に定義しない（判定に使わない）/ archive: `archiveSnapshots`（`knowledge-diff-<step>.md`・`knowledge-<step>-rejected-*/`）/ 掃除: `discardSnapshots`（archiveArtifacts の後・reflection の postActions）/ 分類表: reflection Skill v7 の行 / 許可リスト: 対象外（executor は書かない・エンジンだけが書く）/ パス規約: 報告の中のパスは runtimeRoot 相対 / 2周目: Test 254 / 実配置: 本番の `knowledge.diff` が 1 件以上記録されるまで「効いている」と言わない |
| 2026-10-19 | `schemas/task-metadata.schema.json`（小枠A） | assets に置き aiw init で配る / 版 `schemas.taskMetadata: 1` / 緩い版（オブジェクトであることだけ）。締めるのは実測の後 |
| 2026-10-20 | `runs/<Task ID>/screenshots/after-*.png`（aiw pr・review Skill v9） | 生成: review（spec が env で出力先を受ける画面だけ・撮る手段は作らない）/ contract: 判定に使わないので artifacts に定義しない / archive: 対象外（`runs/<Task ID>/` は archive されず runs/ に残る既存の扱い）/ 掃除: しない（同上）/ 分類表: review Skill v9 の 2 行 / 許可リスト: 変えない（既存の E2E 実行だけ）/ パス規約: runtimeRoot 相対（`aiw pr` の縮退文は runtimeRoot の親から）/ 2周目: 名前に Task ID を含むので前のタスクを上書きしない / 実配置: 本番で `aiw pr` が 1 枚以上添付するまで「効いている」と言わない（実測: after- で書く spec は現状 1 本・BL-373） |
| 2026-10-20 | `context-package.md` を archive の対象へ追加（aiw pr・設計 Q3） | 既存の成果物。archive: `archiveArtifacts` に追加 / 掃除: restore しない（次の research が上書きする既存の扱い）/ 2周目: 次の research が root を上書きしても記録が残ることを Test 274 で固定 |
| 2026-10-23 | `runs/<task-id>/screenshots/before-*.png` / `after-*.png`（aiw pr・implementation v9 / fix v9。上の 2026-10-20 の review の行を置き換え） | 生成: implementation（製品コードを変える前に before・後に after）/ fix（画面を変えたら after を撮り直す）/ contract: 判定に使わないので定義しない / archive: 対象外（runs/ に残る）/ 掃除: しない / 分類表: implementation v9・fix v9 の行、review v9 の行は取り下げ / 許可リスト: 対象外（codex は `runs/<task-id>/` に書ける既存の範囲）/ パス規約: ログと同じ `runs/<task-id>/` / 2周目: Task ID ごとのフォルダ。aiw pr は feature の全タスクから名前で対にする（変更前は最初・変更後は最後・Test 281）/ 実配置: 本番で aiw pr が 1 対以上添付するまで「効いている」と言わない |
| 2026-10-23 | `runs/<task-id>/screenshots/labels.json`（aiw pr・implementation v10） | 生成: implementation（撮った画像ごとに日本語のラベル）/ contract: 判定に使わないので定義しない（壊れていればラベル無しとして扱い --dry-run で見える）/ archive・掃除: スクショと同じ（runs/ に残る）/ 分類表: implementation v10 の行 / 許可リスト: 対象外（`runs/<task-id>/` の既存の範囲）/ パス規約: スクショと同じフォルダ / 2周目: Task ID ごと。feature では後のタスクのラベルを優先（Test 284 はラベルの割り当て）/ 実配置: 本番で見出しの下に 1 対以上置けるまで「効いている」と言わない |
