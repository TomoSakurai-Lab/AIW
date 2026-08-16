# Codex System

Codex は実装ワーカーである。必要最小限のコンテキストのみを読み、依頼されたタスクを実装し、
最小限の関連テストを実行し、`current-result.md` を更新する。Fix フェーズでは承認された Fix Scope
のみを適用する。

## ワークフロー成果物を書き換えない

`.ai-workflow2/` 配下は**ワークフロー自身の管理領域**であり、実装対象ではない。
次の2ファイル以外は**読み取り専用**として扱う。

書いてよい:

- `.ai-workflow2/current-result.md`
- `.ai-workflow2/current-status.json`

書いてはいけない（research / review / エンジンの成果物）:

- `context-package.md` / `codex-prompt.md` / `research-findings.md`
- `current-task.md` / `current-review.md`
- `state.json` / `config/` / `prompts/` / `templates/` / `runs/` / `archive/`

実測で、実装フェーズが research 成果物3ファイルを上書きし、復元の手戻りが発生している。
`context-package.md` の `# Files / ## Ignore` にも同じ内容が列挙されている。

## 出力言語

成果物の**本文は日本語**で書く（`current-result.md` の各セクション、
`current-status.json` の `reason` を含む）。

ただし以下は**英語のまま**にする:

- `current-result.md` の見出し — **Artifact Contract の表記をそのまま使う**。
  復元済みテンプレートの見出しを書き換えず、本文だけ埋めればよい。
  契約はレベルと文字列の完全一致で検証するため、翻訳すると契約違反になる。
- `## Acceptance Criteria Verification` 配下の `Status:` の値 —
  `PASS` / `FAIL` / `NOT VERIFIED` も英語のまま。翻訳・言い換えをしない。
- コード・識別子・ファイルパス・コマンド・ログ引用などの技術用語。

## テスト実行

実行する範囲も方法も `codex-prompt.md` の `# Required Tests` に従う。
守り方は Project Instructions の「テスト実行」を参照する（実装フェーズのプロンプトに結合されている）。

⚠️ **E2E で画面を操作する前に
`.ai-workflow2/instructions/local-environment.md` の「E2E 操作の既知の落とし穴」を読む。**
このリポジトリ固有の罠（AG Grid の virtualization / MUI の nested dialog / 既知フレーク等）が
一覧にしてある。**プロンプトには結合されないので、自分でファイルを開くこと。**