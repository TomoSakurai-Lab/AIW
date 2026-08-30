# Skill: Implementation

implementation ステップで毎回同じように行う手順。
今回のタスクの内容は `codex-prompt.md` と `context-package.md` にあり、ここには書かない。

## 手順

1. `.ai-workflow2/codex-system.md` / `context-package.md` / `codex-prompt.md` を読む
2. **実装計画を立てる。このとき `# Acceptance Criteria Matrix` の全行を、AC ごとの
   検証タスクとして1項目ずつ計画に含め、`.ai-workflow2/ac-manifest.json` に書き出す**（下記）。
   実装方式だけの計画は不完全で、ここで計測を落とすと以降のどの工程でも戻らない
3. `codex-prompt.md` に書かれたタスクを実装する。変更範囲・対象ファイル・受入条件・
   必要テストは**その時々の `codex-prompt.md`（および `context-package.md` の Files）に従う**。
   **過去タスクの内容を引き継がない**
4. `context-package.md` を最小コンテキストとして使い、計画した検証タスクを実行する。
   **AC を1つ検証するごとに `.ai-workflow2/ac-result.json` へ1レコード追記する**（下記）
5. `current-result.md` を**検証パッケージ**として書く（下記）
6. `current-status.json` を書く

## 検証計画 — ac-manifest.json / ac-result.json

**計測の脱落は提出時ではなく、実装計画を立てた時点で起きる**（セッションログの実測:
計画に計測工程が無いまま実装へ入り、既存テストが通った後に「NOT VERIFIED と明記」へ
切り替えて提出した。試行失敗ではなく計画未登録だった）。
だからこの2ファイルは提出物ではなく**計画の成果物**として、実装に入る前に書き始める。

### 実装に入る前: ac-manifest.json

```json
{
  "acceptanceCriteria": [
    { "id": "AC-01", "evidenceKind": "browser" },
    { "id": "AC-02", "evidenceKind": "command" }
  ],
  "pathBase": "checkRepoRoot",
  "consumerChecks": [
    { "id": "AC-04", "root": "Primal.Template.Web.Front/ClientApp/src", "pattern": "motodumori-adjustment" }
  ]
}
```

- **Matrix の全行を載せる。** `evidenceKind` は Matrix の `Verification` 列から決める
  （`command` / `diff` / `browser` / `file` の4値）
- 新しい API・関数・イベントを作るタスクでは、`consumerChecks` に**呼び出し元の存在検査**を
  宣言する（`root`: 検索起点、`pattern`: 参照を示す正規表現）。
  consumer 0 件の「implemented」は consumer-presence validator が違反として review へ渡す
  （実測: API 新設・フロント呼び出し元 0 件のまま完了宣言し Critical になった）
- **`consumerChecks[].root` は checkRepoRoot（検査対象リポジトリのルート）からの相対で書く。**
  `.ai-workflow2/` からの相対ではない。上の例のように、リポジトリのルートから見た
  `Primal.Template.Web.Front/ClientApp/src` の形になる。`pathBase` はその自己申告で、
  現在の許容値は `checkRepoRoot` のみ（省略時も同じ扱い）。基準が変わったときに
  「古い manifest が黙って別の場所を検査する」ことを防ぐために書く
  （2026-09-04 まで validator 側が `.ai-workflow2/` 起点で解決しており、
  正しく書かれた manifest が全件「root does not exist」になっていた。実測 8 件の偽陽性）
- 計測しないと決めた AC も**行を消さず** `"notApplicable": true` と `"reason"` で残す

### タスク開始時に前タスクの ac-* が残っていたら

**確認なしで置き換えてよい。** この2ファイルはタスクごとの作業ファイルであり、
正本は `archive/<feature>/<timestamp>-<task>/` 側にある（reflection が退避してから削除する）。
残っていたらそれは前タスクの退避漏れであって、消してはいけない証跡ではない。
（実測: 「証跡を消してよいか」で実装が停止した。判断を止めるべき場面ではない）

### 計測のたび: ac-result.json

```json
{
  "results": [
    { "id": "AC-01", "status": "passed", "evidenceKind": "browser", "value": "本文行 27px（変更前後で不変）" },
    { "id": "AC-07", "status": "skipped", "reason": "計画に含めなかった: IIS 停止が必要で人間の操作待ち" }
  ]
}
```

- `status` は `passed` / `failed` / `skipped` の三値
- **計画に含めなかった・実行しなかった AC も `"status": "skipped"` + `"reason"`（なぜ
  計測しなかったか）でレコードを残す。** レコード自体が無い AC は measurement-completeness
  validator が欠落として review へ report する。正当な欠落（環境依存・Manual Verification 行き）か
  怠慢な脱落かは review が裁くので、理由を書けば止まらない
- `value` には**その AC の述語を直接観測した値**を書く。既存テストの exit 0 は、
  その AC を観測していない限り証拠にならない（実測: ビルド失敗のまま回した e2e を
  6 本の AC の根拠にして Major になった）

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
