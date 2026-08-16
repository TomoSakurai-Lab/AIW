# Skill: Implementation

implementation ステップで毎回同じように行う手順。
今回のタスクの内容は `codex-prompt.md` と `context-package.md` にあり、ここには書かない。

## 手順

1. `.ai-workflow2/codex-system.md` / `context-package.md` / `codex-prompt.md` を読む
2. `codex-prompt.md` に書かれたタスクを実装する。変更範囲・対象ファイル・受入条件・
   必要テストは**その時々の `codex-prompt.md`（および `context-package.md` の Files）に従う**。
   **過去タスクの内容を引き継がない**
3. `context-package.md` を最小コンテキストとして使い、最小限の関連テストを実行する
4. `current-result.md` を**検証パッケージ**として書く（下記）
5. `current-status.json` を書く

## current-result.md の書き方

必須見出しとその順序は `workflow.yaml` の `artifacts.current-result` が正本。
このファイルには再掲しない。**復元済みテンプレートの見出しをそのまま使い、
本文だけ埋めるのが最も安全**。

### `## Acceptance Criteria Verification`

`context-package.md` の `# Acceptance Criteria Matrix` の **AC ごとに1ブロック**書く。

```md
### AC-01
Status: PASS
Evidence:
- <テスト名 / コマンド出力 / スクリーンショットのパス>
Notes:
- <補足があれば>
```

`Status` の許可値は **`PASS` / `FAIL` / `NOT VERIFIED` の三値**。
三値の扱いと Evidence の実在規則は Project Instructions に従う。

### その他のセクション

- `## Change Map` — 変更の全体像（どのファイル群がどう変わったか）を数行で
- `## Files Changed` — 実際に触れたファイル
- `## Automated Evidence` — 自動テストで裏付けた内容
- `## Manual Verification Required` — 自動検証できず**人間の確認が要る**項目
- `## Unresolved Decisions` — 実装中に判断が必要で、**自分で決めてしまった**こと
- `## Risk Areas` — 影響が読み切れない箇所
- `## Deviations` — 宣言（Scope / 対象ファイル）から外れた点

`Manual Verification Required` と `Unresolved Decisions` を空にしたい誘惑に注意する。
ここが常に空になるのは、実際に何も無いのではなく書いていないだけのことが多い。
