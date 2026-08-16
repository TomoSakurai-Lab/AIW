# aiw 使用方法

`aiw` は 2 つのモードを持ちます。

- **ワークフローエンジン (v0.3, 設計 rev.5)**: `workflow.yaml` 駆動のステートフルな状態機械。検証・分岐・承認・Fix ループの有界化・Event Log・再開を備える。隔離ランタイムルート `.ai-workflow2/`（設計 §12 レイアウト）上で動作し、既存の `.ai-workflow/` には一切触れない。
- **レガシー・プロンプトヘルパー (v0.2)**: 従来の `.ai-workflow/` 向けプロンプト生成（`legacy-status` / `legacy-next` / `research` / `codex` …）。以降の「レガシー」節を参照。

## 前提

Node 20 以上（`cpSync` を使用）。本パッケージは Volta で node 20 に pin 済み。

```powershell
cd tools/aiw
npm install
npm run build          # dist/ を生成（bin: aiw -> dist/cli.js）
npm test               # 必須テスト 12 ケース（tsx 単一プロセス実行）
```

## エンジン・コマンド (rev.5)

```powershell
aiw init [dir]              # ワークフロールートを生成（既定 .ai-workflow2）
aiw --root <dir> status     # エンジン状態を表示
aiw --root <dir> next       # 次アクションを提案
aiw --root <dir> run <step> # 現在ステップの完了処理（§7.7 パイプライン）
aiw --root <dir> approve    # 承認して継続
aiw --root <dir> reject <理由...>   # 却下（policy に応じ rerun / halt）
aiw --root <dir> resume     # halt / 中断からの再開（postAction 失敗地点から冪等に）
aiw --root <dir> prompt [step]      # ステップのフェーズプロンプトを stdout＋クリップボードへ（既定: 現在ステップ）
aiw --root <dir> drive      # 対話 y/n ドライバ（各フェーズを誘導・プロンプトを自動コピー）
aiw --root <dir> new-task   # 次タスク用にリセット（user-task.md + current-* をテンプレへ）
```

ルート解決は `--root` → 環境変数 `AIW_ROOT` → 上位ディレクトリ探索（`config/workflow.yaml`）→ 既定 `.ai-workflow2/`。

各ステップは claude / codex が成果物 + `current-status.json` を作成し、`aiw run <step>` が
検証 → 承認 → 遷移確定 → postActions → state 更新 → ログ の順で完了処理を行う。`result` は
そのステップの `transitions` キーと照合され、未定義値・step 不一致は `invalid-status` で halt。
Fix ループは `fixAttempts`（初回 + `maxRetries` 回）で有界化され、超過時は `escalation` で halt。

`testing`（role: cli）の実行は MVP 範囲外で、`aiw run testing` は state を変えずに非ゼロ終了する。

## 実行方法（`aiw` の呼び方）

`aiw` はまだグローバル install していないので、下記で呼ぶ。以降の例では `aiw` と略記する。

> **Node 20 必須**。このリポジトリの既定 `node` は v14 のことがあり、その場合 `cpSync` 非対応で
> クラッシュする。`tools/aiw` は Volta で node 20 に pin 済みなので、**必ず `tools/aiw` 配下で実行**
> すれば node 20 が使われる（`node -v` で 20 系を確認できる）。

```powershell
# 推奨: tools/aiw から npm script 経由（tsx で src を直接実行・ビルド不要・Volta が node20 を保証）
cd tools/aiw
npm run aiw -- <args>          # 例: npm run aiw -- status

# 代替: tools/aiw 内でビルド済み dist を直接（cwd が tools/aiw なので Volta の node20 が効く）
cd tools/aiw
node dist/cli.js <args>
```

ルートはどこから呼んでも上位ディレクトリを探索して `.ai-workflow2/` を見つけるため、`tools/aiw`
配下で実行してもリポジトリルートの `.ai-workflow2/` を対象にできる。既定 node が 20 以上なら
リポジトリルートから `node tools/aiw/dist/cli.js <args>` でもよい。

## 一番ラクな回し方: `aiw drive`（対話 y/n ドライバ）

フェーズごとに違うコマンドを覚えて打つ代わりに、**`drive` が現在地を見て y/n で聞いてくれる**。
プロンプトが要るタイミングでは自動でクリップボードへコピーする。

```powershell
cd tools/aiw
npm run aiw -- drive
```

挙動:

- **claude / codex ステップ**: そのフェーズのプロンプトを📋クリップボードにコピーして
  「作成できたら y」と聞く。プロンプトを Claude / Codex に貼って成果物 + `current-status.json` を
  作り、`y` を押すと `aiw run <step>` 相当を実行して次へ。
- **承認ゲート**: 「承認しますか？ [y=承認 / n=却下]」。`n` なら却下理由を聞いて `reject`。
- **halt**: 理由を表示して「resume しますか？」。
- **完了（complete）**: 「新しいタスクを始めますか？」→ `y` で `new-task`（下記）してループ継続。
- `n`（や中断）でいつでも抜けられる。準備できたら再度 `aiw drive` で同じ地点から再開。

成果物の生成そのものは代行しない（クリップボードのプロンプトを AI に貼るのは人間の役目）が、
「どのコマンドをどの順で打つか」の負担はゼロになる。

### `aiw new-task` — 次の単発タスクへリセット

`feature-complete` 後は `currentStep: complete`（終端）。次の単発タスクを始めるには:

```powershell
npm run aiw -- new-task     # state を task-planning へ戻し、user-task.md と current-* をテンプレ化
```

その後 `user-task.md` に依頼を書いて `aiw drive`。`drive` の完了時プロンプトから `y` を選んでも同じ。

## shell（REPL）で連続実行 — `npm run` を毎回打たない

一度 `shell` に入れば、以降は `aiw` / `npm run` を付けずに短いコマンドを打ち続けられる。
エンジンコマンド（`status` / `next` / `run <step>` / `approve` / `reject <理由>` / `resume`）が
そのまま使える。

```powershell
cd tools/aiw
npm run aiw -- shell
```

```text
aiw> status                 # エンジン状態
aiw> next                   # 次の一手を提案
aiw> prompt                 # 現在ステップのプロンプトを stdout＋クリップボードへ（Claude に貼る）
aiw> run task-planning      # 完了処理 → 承認ゲートで awaiting approval
aiw> approve                # 承認して research へ
aiw> prompt                 # research のプロンプトをコピー → Claude に貼って成果物を作る
aiw> run research
aiw> approve
aiw> ...
aiw> help                   # コマンド一覧（engine / legacy を分けて表示）
aiw> exit                   # 終了
```

各ステップの成果物は、`prompt` でフェーズプロンプトをクリップボードへ出し、それを Claude
（codex ステップなら Codex）に貼って生成する流れになる。`prompt` に引数を付ければ任意ステップの
プロンプトも出せる（例: `prompt review`）。codex ステップ（implementation / fix）も
`prompts/implementation.md` / `prompts/fix.md` を持ち、`prompt implementation` で Codex 用の
指示（`codex-system.md` / `context-package.md` / `codex-prompt.md` を読んで実装、という文面）が
出る。Codex にはこのプロンプトと、そこで参照される各ファイルを渡す。`testing`（role: cli）だけは
プロンプトを持たない。

- シェル内の `status` / `next` は**エンジン版**（`.ai-workflow2/`）。旧 `.ai-workflow/` 向けの
  プロンプト生成は `legacy-status` / `legacy-next` / `research` / `codex` … として引き続き使える。
- コマンドがエラー（例: `current step is "task-planning", not "research"`）でも REPL は落ちず、
  次の入力を受け付ける。
- ただし各ステップの**成果物 + `current-status.json` を作る作業は別途必要**（REPL は状態遷移の
  司会役で、成果物生成そのものは代行しない）。`run <step>` の前に成果物を用意しておくこと。

## エンジンの考え方（重要）

**エンジンは作業を代行しない。** claude / codex の各ステップは、あなた（＝ここの Claude / Codex）が
成果物と `current-status.json` を先に作り、そのうえで `aiw run <step>` が「検証 → 承認 → 遷移」を
行うだけの**司会・検証役**である。したがって 1 ステップは必ず次の 2 段構えになる。

1. **作る**: `.ai-workflow2/prompts/<step>.md` の指示を Claude（codex ステップなら Codex）に渡し、
   規定の成果物 + `current-status.json` を出力させる。
2. **回す**: `aiw run <step>` で完了処理。承認ゲートのあるステップは続けて `aiw approve`。

> **注意 — `current-status.json` はステップごとに作り直す**: `approve` で次ステップへ遷移した
> 直後は `current-status.json` が前ステップの宣言のまま。新ステップの成果物と一緒に
> `{ "step": "<新ステップ>", ... }` を書き直してから `run` する。うっかり前のまま `run` しても、
> それが「直前ステップの宣言のまま」であれば **halt せず平易なエラー**で「新ステップ用に書き直して
> 再実行」と案内する（state は変わらず `aiw resume` も不要）。`aiw next` も同じ状況を検知して
> 書き直しを促す。それ以外の step 表記ズレ（越境）は従来どおり `invalid-status` で halt する。

## 1 タスクを最後まで通す（ハッピーパス）

| 順 | step | 担当 | 先に作る成果物 | 実行するコマンド | 承認 |
| --- | --- | --- | --- | --- | --- |
| 1 | `task-planning` | Claude | `current-task.md` + `current-status.json`(`planned`) | `aiw run task-planning` | ① `aiw approve` |
| 2 | `research` | Claude | `context-package.md` + `codex-prompt.md` + status(`research-complete`) | `aiw run research` | ② `aiw approve` |
| 3 | `implementation` | Codex | `current-result.md` + status(`implemented`) | `aiw run implementation` | なし |
| 4 | `review` | Claude | `current-review.md` + status(`ready` または `fix-required`) | `aiw run review` | ③ `aiw approve` |
| 5a | → `ready` | — | （そのまま reflection へ） | | |
| 5b | → `fix-required` | Codex | `current-result.md` + status(`fixed`) | `aiw run fix` | なし（回数上限あり） |
| 6 | `improve-check` | Claude | status(`ready-for-reflection` / `ready-for-test` / `fix-incomplete`) | `aiw run improve-check` | なし |
| 7 | `reflection` | Claude | `context.md` / `learnings.md` / `backlog.md` + status(`feature-complete` など) | `aiw run reflection` | なし |

補足:

- **承認ゲートは 3 箇所だけ**（task-planning / research / review の直後）。ここでは `aiw run` の後に
  `awaiting approval` と出るので、`aiw approve`（承認）または `aiw reject <理由>`（差し戻し）を打つ。
- **fix ループ**は `improve-check` が `fix-incomplete` を返すと `fix` に戻る。回数は `fixAttempts`
  （初回 + `maxRetries`=2、計 3 回）で有界。超過すると `escalation` で halt する。
- **`ready-for-test`（testing 経路）は未実装**。`testing` は role: cli で MVP 範囲外のため、
  `improve-check` が `ready-for-test` を返すとその先へは進めない。当面は Test Required を「不要」と
  判定して `ready-for-reflection` を返す運用にする。

## 今どこにいる？次に何を打つ？

迷ったら次の 2 つ。**まず `status`、次に `next`**。

```powershell
aiw status   # currentStep / status / 待ち承認 / fixAttempts / そのステップの取りうる result を表示
aiw next     # 現在地から見た「次に打つべき 1 コマンド」を提案（作業の代行はしない）
```

- `pendingApproval` が出ていたら → `aiw approve` か `aiw reject <理由>`。
- `halted` なら → 原因（`haltedReason`）を直してから `aiw resume`。
- それ以外 → `aiw run <currentStep>`（その前に成果物 + `current-status.json` を作ってあること）。

### 例: 今回の初回タスク（TASK-001）はここから

いま `task-planning` の成果物（`current-task.md` + `current-status.json`=`planned`）は作成済み。
なので次はこう進む。

```powershell
aiw run task-planning     # 検証 → 承認ゲート① で "awaiting approval" になる
aiw approve               # 承認 → research へ遷移
# ここで prompts/research.md を Claude に渡し、context-package.md / codex-prompt.md を作る
aiw run research
aiw approve               # 承認ゲート② → implementation へ
# 以降 表のとおり implementation → review(承認③) → (fix →) improve-check → reflection
```

---

## レガシー（プロンプトヘルパー v0.2）

以下は従来の `.ai-workflow/` 向けプロンプト生成モード。`status` / `next` はエンジンが使うため、
レガシーは `legacy-status` / `legacy-next` に改名されている。`aiw` は `.ai-workflow/` 配下の状態管理と、Claude / Codex に渡すプロンプト生成を補助するローカルCLIです。AI API連携は行わず、生成したプロンプトを標準出力に表示し、可能であればクリップボードへコピーします。

## セットアップ

```powershell
cd tools/aiw
npm install --ignore-scripts
```

## 基本実行

```powershell
npm run dev -- status
npm run dev -- next
npm run dev -- heartbeat
npm run dev -- research
npm run dev -- codex
npm run dev -- review
npm run dev -- fix
npm run dev -- improve-check
npm run dev -- reflect
```

`tools/aiw` から実行しても、親ディレクトリ方向に `.ai-workflow/` を探して動作します。

## 推奨フロー

```text
aiw status
aiw next
aiw next
aiw next
...
```

`next` は `state.currentStep` や主要ファイルの状態を見て、次に必要なフェーズのプロンプトを生成し、可能であればクリップボードへコピーします。`heartbeat` はCodexの実装待ちが長いときに `next` から選ばれることがあります。`review` 後に `READY FOR FIX` なら `fix`、`READY FOR REFLECTION` なら `reflect` へ進みます。

## コマンド一覧

| コマンド | 用途 |
| --- | --- |
| `status` | `.ai-workflow/state.json` を管理し、主要Markdownの存在確認を表示します。Markdown成果物自体は各フェーズ/エージェントが作成します。 |
| `next` | `state.currentStep`、主要ファイル、`current-review.md` の `READY FOR FIX / READY FOR REFLECTION` を見て、次フェーズのプロンプト生成・コピーまで実行します。判断不能な場合だけ候補表示で止まります。 |
| `heartbeat` | Codex待機中にClaudeへ送るheartbeatプロンプトを生成します。 |
| `research` | `.ai-workflow/prompt-templates/research.md` を使ってプロンプトを生成します。 |
| `codex` | `.ai-workflow/prompt-templates/coding.md` を使ってプロンプトを生成します。 |
| `review` | `.ai-workflow/prompt-templates/review.md` を使ってプロンプトを生成します。 |
| `fix` | `.ai-workflow/prompt-templates/improve.md` を使ってプロンプトを生成します。 |
| `improve-check` | `.ai-workflow/prompt-templates/improve-check.md` を使ってプロンプトを生成します。 |
| `reflect` | `.ai-workflow/prompt-templates/reflection.md` を使ってプロンプトを生成します。 |

`status` の存在確認対象は以下です。

```text
.ai-workflow/current-task.md
.ai-workflow/context-package.md
.ai-workflow/codex-prompt.md
.ai-workflow/current-result.md
.ai-workflow/current-review.md
```

## Fix Scope 運用

`aiw review` は `current-review.md` に以下のセクションを含める前提のプロンプトを生成します。

```md
# Fix Scope

## Files To Modify

## Critical

## Major

## Acceptance Criteria

## Test Required
```

`aiw fix` は `current-review.md` 全体ではなく、この `Fix Scope` のみを修正対象として扱います。Minor / Good / Backlog は修正対象に含めません。`fix-package.md` は作成しません。

## context-package.md

`context-package.md` は、Codexへ渡す最小コンテキストです。Codexが `context.md` や `research/` 全文を読まずに済むよう、Researchフェーズで生成・更新します。

## state.json

`.ai-workflow/state.json` がなければ初期値で作成します。`currentStep` は以下を扱います。

```text
idle
research
codex-running
review
fix
improve-check
reflection
done
```

## プロンプトテンプレート

各フェーズのプロンプトは `.ai-workflow/prompt-templates/` から読みます。該当ファイルがない場合のみ、CLI内の最小フォールバック文面を使います。

```text
.ai-workflow/prompt-templates/research.md
.ai-workflow/prompt-templates/coding.md
.ai-workflow/prompt-templates/review.md
.ai-workflow/prompt-templates/improve.md
.ai-workflow/prompt-templates/improve-check.md
.ai-workflow/prompt-templates/reflection.md
```

`heartbeat` だけは従来どおり `.ai-workflow/prompts/heartbeat.md` があればそれを使い、なければCLI内のデフォルト文面を使います。

## 注意

- `.ai-workflow/` が見つからない場合はエラーになります。
- クリップボードコピーに失敗してもCLIは失敗扱いにせず、標準出力には必ずプロンプトを表示します。
- AI API連携や自動実行は行いません。
