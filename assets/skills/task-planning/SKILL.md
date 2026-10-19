# Skill: Task Planning

task-planning ステップで毎回同じように行う手順。依頼の中身は `user-task.md` にあり、ここには書かない。
見出し・ID・表の書式の正本はテンプレート `current-task.md` と workflow.yaml の契約。**ここでは書式を繰り返さない。テンプレートの形をそのまま埋める**。

## 位置づけ

- 仕事は**整形**: 人間が書いた依頼（`user-task.md`）を、漏れなく `current-task.md` の形へ写す。依頼の中身を決めるのは人間で、
  task-planning は依頼に無い要求を作らない。人間と機械の境界は「`user-task.md` を人間が書く」ところにある
- 実装の調査・ソースの変更・Codex 向けプロンプトの作成はしない（research 以降の仕事）

## 手順

1. `user-task.md` / `context.md` を読む。続きのフェーズなら `feature.md`、積み残しを拾う依頼なら `backlog.md` も読む
2. 単一タスクか、複数フェーズの feature かを決める。分解が要るときだけ `feature.md` を書く
3. テンプレート `current-task.md` を埋める: Goal / Scope / Requirements / Out of Scope / Acceptance Criteria。
   **Requirements・Out of Scope・Acceptance Criteria は 1 項目 1 行で ID を振る**（AC の ID は research がそのまま引き継ぐ）
4. **`## Request Mapping` の表を作る**: `user-task.md` の文・箇条を上から順に 1 行ずつ取り、写った先の ID を書く。
   - 要求は R（やる）か O（やらない）へ。検証の形まで依頼にあれば AC も並べる
   - 要求でない背景・経緯の説明文は **G**（Goal）へ写す。⚠️ **G へ写した文は実装への拘束力を持たない**——「取りこぼしていない」の証明であって要求ではない。
     要求らしき文（「〜にする」「〜しない」「〜を調べる」）を G へ逃がさない
   - 依頼の文が表に無いことは、取りこぼしと同じ。依頼の全文を表に通す
5. **依頼に由来しない要件**（既存のビルド・テストを壊さない、など依頼に書かれていないが要るもの）を足したときは、
   `### Added Requirements` に `R<n>: <根拠 1 行>` で申告する。無ければ「なし」と書く。黙って足さない
6. backlog の候補: `backlog.md` の **`Status: open` の項目だけ**を、**依頼の言葉**（画面名・コンポーネント名・依頼に書かれた BL-ID）で照合し、
   拾えそうなものを `# Task` に ID + 1 行で列挙する（最大 5 件）。拾うかはゲート①で人間が決める。勝手に Scope へ入れない。
   コードの言葉（ファイル名・識別子）での照合は research が `## Modify` を決めた後に行う（照合の鍵が違うので二度打ちではない）
7. `current-status.json` を書く（`step` はステップ ID と完全一致）

## 迷ったとき

- 依頼の文意が曖昧で写像先を決められないときは、決めつけずに R へ「〜を確認する（判断を仰ぐ）」として写し、research の Open Decisions へ渡す
- 依頼の範囲を広げたくなったら、それは Added Requirements に根拠つきで書くか、Out of Scope に書く。どちらもゲート①で人間に見える
