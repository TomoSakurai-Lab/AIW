# codex executor 設計（M3）

**状態**: ドラフト（未承認）。承認後に実装スコープへ進む。

**目的**: implementation / fix の手貼りを消す。プロンプトの組み立てから Codex の実行、
成果物の回収までを `aiw exec` の中で完結させる。

## 前提（確定済み・再検討しない）

| # | 前提 | 出典 |
| --- | --- | --- |
| 1 | `codex exec` のプロセス毎起動。mcp-server 常駐案は棄却 | m3-design-inputs §5 |
| 2 | pin は npm `@openai/codex@0.147.0`。`.sandbox-bin/codex.exe` は使わない | 同 §4 |
| 3 | resume は最適化。失敗時は fresh へフォールバック。生 session ID をログに残さない | 同 §1-1 / §1-2 |
| 4 | MCP 事前検証は `aiw_validate` 1本・読み取り専用・制約4点 | 同 §6 |
| 5 | 抽象化しない。Canonical Primitive の判定は M4.4 | — |
| 6 | validator は1つも変更しない。clipboard へのロールバック可能性を維持 | CLAUDE.md 不変条件 4 / 5 |
| 7 | 予算はステップ実行回数が主。トークンは補助指標として記録を開始 | — |

---

# 調査結果（実測）

すべて 2026-08-18、pin 済み `codex-cli 0.147.0`（`tools/aiw/node_modules/.bin/codex`）で実測。
probe は使い捨ての git リポジトリ（`.gitignore` に `/.ai-workflow2/` を持つ本番同型）に対して実行した。

## 1. コマンドライン長とプロンプトの実サイズ

`execFile`（shell 非経由）で二分探索した引数長の上限:

| 項目 | 実測 |
| --- | ---: |
| 単一引数の上限 | **約 32,481 文字で成功 / 32,870 文字で失敗** |

組み立て済みプロンプトの実サイズ:

| step | bytes | 文字数 | 上限に対する比 |
| --- | ---: | ---: | ---: |
| research | 18,926 | **11,724** | **36%** |
| reflection | 13,458 | 8,035 | 25% |
| review | 14,108 | 7,811 | 24% |
| fix | 8,284 | 4,794 | 15% |
| implementation | 7,764 | 4,578 | 14% |
| improve-check | 3,361 | 2,203 | 7% |
| task-planning | 2,339 | 1,415 | 4% |

⚠️ **「約60KB」という当初の想定は誤り**だった。60,980 は8ステップの bytes 合計であり、
1ステップあたりではない。かつ日本語は UTF-8 で 1 文字 3 バイトなので、
コマンドライン長の単位（文字）に直すと 1/3 になる。

## 2. プロンプトの受け渡し（stdin）

`codex exec` は `PROMPT` 引数を省略して `-` を渡すと stdin から読む。実測で成功（exit 0）。

## 3. サンドボックスと書き込み範囲

| 実測 | 結果 |
| --- | --- |
| `-s workspace-write` で `-C` 配下の **gitignore されたディレクトリ**（`.ai-workflow2/`）へ書けるか | **書けた**（`--add-dir` 不要） |
| `-s read-only` で書き込みを命じた場合 | ファイルは作られず、**exit code は 0**。エージェントが「read-only なので書けない」と説明して正常終了 |
| `--approve-for-me` なしの workspace-write でファイル書き込み | **承認待ちにならず完了** |

⚠️⚠️ **exit code 0 は「作業をした」を意味しない。** 拒否・未実施でも 0 で返る。

## 4. `--json` のイベント形

trivial なタスク1回で 6 行。

```text
{"type":"thread.started","thread_id":"01a013b1-…"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"file_change","changes":[{"path":"…"}]}}
{"type":"item.completed","item":{"id":"item_0","type":"file_change","changes":[…]}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":26539,"cached_input_tokens":13056,
  "cache_write_input_tokens":0,"output_tokens":109,"reasoning_output_tokens":42}}
```

失敗時は `{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 …)"}` が出る。
**リトライは 5 回**で、それを使い切ってから終了する。

`thread.started.thread_id` が**生の session ID** である。ここが不変条件6 の接点。

## 5. トークン

`turn.completed.usage` に全部入っている。**Event Log の token 系 null 問題はここで解消する。**

⚠️ trivial なプロンプト（1文）でも `input_tokens: 26539`。
これは system prompt とツール定義の固定費であり、**プロンプト本体の大きさではない**。
`cached_input_tokens: 13056` は 2 回目以降の実行で効く。

## 6. `--output-schema`

`{"type":"object","required":["step","result","reason"],"additionalProperties":false}` を渡して
「Say hello」とだけ指示した結果、最終メッセージが
`{"step":"Greeting","result":"Hello!","reason":"…"}` で返った。

**形は強制される。ただし値の妥当性は保証されない**（`result: "Hello!"` は遷移キーとして無効）。

## 7. CODEX_HOME と認証

| 実測 | 結果 |
| --- | --- |
| 空の `CODEX_HOME` + `--ignore-user-config` | **401 Unauthorized / exit 1**。5 回リトライして失敗 |
| 認証の実体 | `$CODEX_HOME/auth.json`（4,001 bytes） |
| 隔離 CODEX_HOME に生成されたもの | `installation_id` / `skills/` / `*.sqlite`（goals / logs / memories / queue / state）ほか |

⚠️⚠️ **`codex exec` はデスクトップアプリの `~/.codex/config.toml` を書き換える。**
probe を1回流しただけで `[projects.'…\scratchpad\codex-probe']` が追記された。
**隔離しない限り、aiw の実行はアプリの設定ファイルを毎回汚す。**

## 8. MCP 登録

`~/.codex/config.toml` には既に `[mcp_servers.node_repl]`（デスクトップアプリのもの）がある。
`codex mcp add` は**このファイルを書き換える**ため使えない（「やらないこと」に該当）。
キーは `mcp_servers.<name>` なので、`-c mcp_servers.aiw.command=…` の形でコマンドラインから注入できる。

---

# 設計課題ごとの選択肢

## 課題A: 起動形態

### A-1. プロンプトの受け渡し ← 推奨: stdin

| 案 | 成立するか | 論点 |
| --- | --- | --- |
| argv | **今日は成立する**（最大 36%） | 上限に近づいたときの失敗が遅く不明瞭。`local-environment.md` は今日1日で 4,718 → 9,557 bytes に倍増しており、research は最も伸びるステップ |
| **stdin（推奨）** | 成立（実測） | 長さの上限が実質無い。引用・エスケープの問題が消える |
| 一時ファイル + `-C` 経由の指示 | 成立しうる | プロンプトをディスクへ置く手間と後始末が増える。stdin で足りる |

**stdin を採る。** 理由は「今は入るが、入らなくなったときに何が起きるか」で選ぶため。
argv 超過は OS レベルのエラーになり、原因がプロンプトの伸びだと気付きにくい。
**プロンプトの成長が機能に影響しない構造**にしておく。

実装は `execFile`（**shell を経由しない**）+ 絶対パスで起動し、`child.stdin` へ書いて閉じる。
`shell: true` を使わないのは KI-08（タイムアウトが exit 1 に化けて本物の失敗と区別できない）を避けるため。

### A-2. 作業ディレクトリと書き込み範囲

- `-C` には `resolveCheckRepoRoot(runtimeRoot, config)` の結果を渡す（**gitScope の解決をそのまま再利用**）。
  diff-scope が検査する範囲と Codex が触れる範囲を**同じ値から導く**ことで、
  「検査範囲外を書き換えた」が構造的に起きにくくなる
- 実測により、`.ai-workflow2/` が `-C` の配下にある限り **`--add-dir` は不要**
- ⚠️ ただし `settings.repoRoot` を runtime root の外へ向けた場合、`.ai-workflow2/` が
  workspace の外に出る。**起動前に「runtimeRoot が checkRepoRoot の配下か」を検査し、
  外なら `--add-dir <runtimeRoot>` を足す**。判定できないときは起動しない（黙って書けない状態で走らせない）

### A-3. CODEX_HOME の隔離 ← **決定済み**（2026-08-18 承認）

**隔離は選択ではなく必須。** 1 回の probe で、デスクトップアプリの `config.toml` に
`[projects.…]` が追記される実害が観測されたため。
隔離の目的は「設定の混入を防ぐ」だけでなく **「相手の設定を汚さない」** 側にもある。

決定内容:

| 項目 | 決定 |
| --- | --- |
| 配置 | **`.ai-workflow2/.codex-home/`**（`settings.codexHome`、既定は runtime root からの相対 `.codex-home`） |
| 認証 | **隔離 home で `codex login` を1回**。`auth.json` の複製は却下 |
| 実行者 | **login は人間が手で行う**（credentials を AI セッションに触らせない） |
| バックアップリポ | `.gitignore` に `/.codex-home/` を追加し、**理由を併記する** |

`.gitignore` に書く理由（この文言を残す）:

```text
# 認証情報（auth.json）を含むため。バックアップ対象は知識であり credentials ではない。
/.codex-home/
```

**`auth.json` の複製を却下した理由**は陳腐化だけではない。
複製した瞬間に「どちらが正か」が曖昧になり、デスクトップアプリ側の再認証で
片方だけ更新される。**KI-01（同名で中身が違う）の認証版**になる。

以下は決定に至った検討の記録。

| 案 | 内容 | 評価 |
| --- | --- | --- |
| (a) 隔離しない | `--ignore-user-config` だけで config の混入を防ぐ | ✗ **実行のたびにアプリの config.toml へ `[projects.…]` が書かれる**（実測）。「アプリの設定に書き込まない」を満たせない |
| (b) 隔離 + `auth.json` を複製 | 起動時に `~/.codex/auth.json` をコピー | △ 認証情報の複製が増える。ローテーションで陳腐化する |
| **(c) 隔離 + 一度だけ login（推奨）** | 専用 CODEX_HOME で `codex login` を1回実行 | ✓ アプリと完全に独立。以後の更新・再ログインもアプリと無関係 |

**配置**: `settings.codexHome`（既定 `.codex-home`、runtime root からの相対）。

⚠️ **`auth.json` は絶対にコミットしない。**
`.ai-workflow2` のバックアップリポジトリは**列挙式の .gitignore** なので、
新しいディレクトリは `git status` に出る。**出た時点で無視リストへ追加する**運用にする
（黙って追跡されるより、見えて判断するほうを選ぶ）。

**MCP 登録先**: 隔離 CODEX_HOME の `config.toml` ではなく、**`-c mcp_servers.aiw.*` でコマンドラインから注入する**。
`--ignore-user-config` を付ける以上 config.toml は読まれないため、ファイルに書いても効かない。
副次的に、設定ファイルを一切書かないので「どの設定で走ったか」がコマンドラインに全部残る。

### A-4. サンドボックスと承認フラグ

**`-s workspace-write` + `--approve-for-me` + `--ephemeral`（段階1）。**

- `workspace-write` だけでワークスペース内のファイル書き込みは**承認なしで通る**（実測）
- `--approve-for-me` は、ワークスペース外やネットワークなど**昇格が要る操作**のための保険。
  無人実行で止まらないために付ける
- `--ephemeral` はセッションファイルを残さない。段階1では resume を使わないので既定にする
- `--ignore-user-config` / `--strict-config` を併用し、設定の混入と typo を落とす

⚠️ **BL-050 / BL-054 が pin 版 + 隔離 CODEX_HOME で再発しないかは未確認。**
実タスクを1本流すまで確定しない（→ 実装スコープの受け入れ確認に含める）。

## 課題B: 出力の回収

### B-1. JSONL の保存と転記

- **生の JSONL は `runs/codex/<taskRunId>-<step>-<n>.jsonl` へ保存**する（診断用の一次資料）
- **Event Log へ転記するのは要約のみ**:
  `usage`（→ トークン）/ `item.type` ごとの件数 / `error` の件数と先頭メッセージ /
  exit code / `durationMs` / `threadRef`（hash・後述）
- ⚠️ **エージェントの本文（`agent_message.text`）を Event Log へ入れない。**
  Event Log は「観測」の記録であり、成果物の写しではない。
  肥大するうえ、`aiw status --summary` の Claimed / Observed の分離が壊れる

### B-2. `current-status.json` の受け取り ← 段階1では `--output-schema` を使わない

実測のとおり `--output-schema` は形を強制するが値は保証しない。
一方、現行の Skill は「`current-status.json` をファイルに書く」ことを指示しており、
`json-schema` validator と `completion.ts` の許可値照合が既に効いている。

**段階1は現行のまま**（エージェントがファイルを書き、既存 validator が検査する）を採る。理由:

1. **clipboard との差分を最小にする**。executor を切り替えても成果物の作られ方が同じなら、
   不変条件5（clipboard へ戻せる）が実際に成立する
2. `--output-schema` を入れると「最終メッセージ」と「ファイル」の2経路ができ、
   食い違ったときにどちらが正かの規則が要る

**`-o, --output-last-message <FILE>` は付ける**（診断用。`runs/codex/` へ保存し、
Event Log へは入れない）。将来 `--output-schema` を採る場合の材料になる。

### B-3. `current-result.md`

現行どおり Codex がファイルとして直接書く。書かれなかった場合の検出は
既存の `file-exists` validator に委ねる。**executor は成果物を検証しない。**

### B-4. トークン計測の開始

`turn.completed.usage` を Event Log の既存フィールドへ写す:

| usage | Event Log |
| --- | --- |
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `cached_input_tokens` | `cacheReadTokens` |

`cache_write_input_tokens` / `reasoning_output_tokens` は新フィールドとして足す
（既存3つの意味を変えない）。

**baseline への追加**: M3 世代のエントリに次を記録する。

```text
■ トークン（M3 で初計測）
implementation : input / cacheRead / output
fix            : 同上
cacheRead / input の比 : ← Instructions 再送がキャッシュに吸収されているか（§2 の指標）
```

⚠️ **固定費に注意**。trivial な1文でも input 26,539 だった。
プロンプトを削ってもこの下限は下がらない。**削減効果を測るなら差分で見る。**

## 課題C: 失敗の分類

### C-1. `failureKind`

`ExecutorResult` に `failureKind?: "transient" | "permanent"` を足す。

⚠️ **分類の入力に exit code を使わない。** C-3 の実測（拒否されても exit 0）により、
exit code は「プロセスが完走したか」しか語らない。分類は
**JSONL のイベント内容（`error` の有無と文面）と、成果物の有無**から導く。

これは偶然ではなく、既存の責務分離
（executor は成果物を検証しない / 当否は validator が決める）が
**そのまま正しい防御になっていた**ということでもある。

| 観測 | 分類 | 根拠 |
| --- | --- | --- |
| `error` イベントに `Reconnecting… n/5` が出て exit 非0 | `transient` | ネットワーク・レート制限。再試行に意味がある |
| 401 / 認証系で exit 非0 | `permanent` | 資格情報の問題。再試行しても同じ |
| spawn 失敗（ENOENT） | `permanent` | pin が壊れている |
| タイムアウト | `transient` | C-2 |
| exit 0 | 失敗ではない | **成果物の当否は validator が決める** |

M5 の `consecutiveExecFailures` が「再試行すべきか即停止か」を判断するために使う。

### C-2. タイムアウト

KI-08 の再発防止として**二重判定**を仕様にする。

```text
timedOut = (error.code === "ETIMEDOUT") || (signal !== null) || (durationMs >= timeoutMs)
```

`shell: false` で起動するので `signal` は信頼できるが、`verifyLocal` と同じ形を保つ
（片方だけに依存しない）。タイムアウトは `failureKind: "transient"`。

### C-3. exit code の意味 ← **成功判定に使わない**

実測のとおり、read-only で書き込みを拒否されても exit 0 で返る。
**exit code が保証するのは「プロセスが最後まで走った」ことだけ。**

executor は `ok: true`（プロセス完走）を返し、
**成果物の有無・内容は `aiw run` の validator が決める**。この分離は現行と同じで、変えない。

### C-4. `ExecutorRequest` の任意フィールド追加

`signal?: AbortSignal` / `projectRoot?: string` / `timeoutMs?: number` を optional で足す。
optional なので `clipboard.ts` は無変更で通る（M0.4 レビューで確認済み）。

## 課題D: セッション（段階制）

### 段階1（M3 の本体）: fresh 固定

`--ephemeral` を付け、resume を一切使わない。**これだけで手貼りは消える。**

### 段階2（任意最適化）: task-scoped resume

着手判定は**段階1のトークン実測を見てから**。
「同一タスク内で implementation → fix のときコードベース再読み込みが浮くか」を
`cached_input_tokens` の実測で確認してから決める。

必須条件（v1 計画から転記。1つでも満たせないなら段階2は入れない）:

- session ID が無くても**成果物ファイルだけで fix を実行できる**
- resume 失敗は halt にせず fresh へフォールバックする
- `taskRunId` 不一致の session ID は拒否する
  （**`taskRunId` の実装もここに含む**。現状は「最後の reflection 遷移以降」という暫定窓で代用している）
- reflection 完了時に破棄する
- **ログには hash / 短縮形のみ。型で強制する**

### 型分離（段階2の前提。段階1で先に切っておく）

```ts
// 生の値を持てるのはここだけ。プロセス起動の引数にしか渡さない。
type SessionSecret = { readonly raw: string };
// ログ・Event Log・成果物へ出せるのはこちらだけ。
type SessionRef = { readonly hash: string; readonly tail: string };
```

`versions.ts` の `skillHash` に倣う。**生 ID を保持できる型をログ経路に存在させない。**

## 課題E: MCP 事前検証 ← 推奨: executor 安定後（段階1の完了後）

**同時に入れない。** 根拠は3つ。

1. **変数が2つ動く。** Fix 発生率が変わったとき、executor の効果か MCP の効果か分離できない。
   M2 世代の G-2（100% / n=8）が交絡で判断不能になったのと同じ失敗を繰り返す
2. **トークンの基準線が取れなくなる。** §2 のキャッシュ戦略の判定は
   `cacheReadTokens / inputTokens` の比で行うが、`aiw_validate` の呼び出しは
   この比を動かす。**まず executor 単独の基準線を測る**
3. 実測の固定費が大きい（trivial で input 26,539）。ツール定義が増えると固定費も増える。
   増分を測るには「増える前」が要る

ただし**設計は M3 のうちに固める**（下記）。実装だけを後ろに置く。

### 最小実装の形

- `aiw_validate` 1本。stdio の MCP サーバーとして aiw に組み込む（`aiw mcp-serve` 相当）
- **制約4点はサーバー側で強制する。** クライアント（エージェント）の分別に期待しない
  - 上限3回: サーバーがステップごとに呼び出し回数を持ち、超過時は**エラーではなく**
    「宣言して `aiw run` に委ねよ」の定型応答を返す
  - 差分なし検査スキップ: 成果物の sha256 を前回値と比較し、同一なら検査せず
    「変更が観測されていない」を返す
  - 要約応答（1〜3行）。詳細はディスクの成果物を読ませる
  - 全呼び出しを Event Log へ記録
- 登録は `-c mcp_servers.aiw.command=…`（A-3）
- Event Log の種別: `precheck.called` / `precheck.skipped-nochange` / `precheck.limit-reached`
- **読み取り専用に限定**。`aiw_approve` 等の変更系は公開しない

## 課題F: 「強制: なし」3項目の防衛線

CLAUDE.md で `強制: なし` の3項目は、M3 実装が最も破りやすい。
**executor と同一コミットで防衛線を入れる。**

### F-1. 再実行可能性（不変条件2）

**故障注入テスト**: 実行途中で子プロセスを kill → 成果物ファイルだけから再実行 → 完走する。
会話履歴でステップを繋いでいたら、この経路は通らない。

### F-2. 生 session ID を残さない（不変条件6）

- 型分離（課題D）
- **grep テスト**: Event Log 全文と `runs/` の要約に `thread_id` の生値が現れないこと。
  Test 58（`recaptureBaseline` を対話 CLI 以外が import していないこと）と同じ方式

### F-3. 契約を再記述しない

**executor はプロンプトへ何も足さない。** 組み立ては `promptAssembly` の責務のまま。
executor が渡すのは `assembleStepPrompt` の出力そのものだけ。

⚠️ 誘惑の形: 「Codex がファイルを書き忘れるので、executor 側で
『必ず current-result.md を書け』を末尾に足す」。これをやると契約の出どころが 2 箇所になる。
**足したくなったら Skill か Step プロンプトへ足す。**

防衛線: **コードレビュー項目として明記**（機械的強制はしない。プロンプト本文の比較テストは
組み立て順テストと重複し、壊れやすいわりに得るものが少ない）。

## 課題G: 故障注入（実装の完了条件）

| # | 注入 | 期待 |
| --- | --- | --- |
| 1 | 実行途中で kill | fresh 再実行で完走（F-1） |
| 2 | タイムアウト | `transient` として記録。**`failed` に化けない**（KI-08） |
| 3 | codex が exit 0 でゴミを出す | executor は `ok: true`。`aiw run` の validator が捕捉（C-3） |
| 4 | `current-result.md` を書かずに終了 | `file-exists` が halt |
| 5 | Event Log に生 ID | grep テストで検出（F-2） |
| 6 | `executor: clipboard` へ戻す | 従来動作で完走（不変条件5） |
| 7 | 認証切れ（`auth.json` を退避） | `permanent` として記録し、再試行しない |
| 8 | `runtimeRoot` が `checkRepoRoot` の外 | 起動せずに停止（A-2） |
| **9** | **exit 0 + 成果物なし**（read-only 拒否パターン） | `file-exists` が halt し、**executor は「成功」を報告していない**こと。`failureKind` がこのケースを正しく扱うこと |

⚠️ **9 は実測で確認された実在の失敗モード**（C-3）。
「exit 0 だから成功」と読む実装を将来入れさせないための固定点なので、
このテストを消すこと自体が違反にあたる。

## 課題H: 世代管理

- **M3 実装後の最初のタスクから「M3 世代」**として baseline を仕切り直す
- **G-2（M2 世代 Fix 率）は clipboard 運用のタスクのみで判定する。**
  n=12〜13 に届かないまま M3 へ移る場合は
  **「途中打ち切り・M3 世代で仕切り直し」と明記**して、混ぜない
- M3 世代の初期観察項目:
  1. **手貼り回数 0 の確認**（M3 の主目的の達成確認）
  2. **トークン実測の開始**（`cacheReadTokens / inputTokens` の比）
  3. Fix 率
  4. **executor 失敗率（`failureKind` 別）**

---

# 推奨案（まとめ）

```text
execFile(<pin された codex 実行ファイルの絶対パス>, [
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--strict-config",
  "-s", "workspace-write",
  "--approve-for-me",
  "-C", <checkRepoRoot>,
  "-o", <runs/codex/....last-message.txt>,
  ...(runtimeRoot が checkRepoRoot の外なら ["--add-dir", runtimeRoot]),
  "-"                       // プロンプトは stdin
], {
  env: { ...process.env, CODEX_HOME: <settings.codexHome の絶対パス> },
  shell: false,             // KI-08
  timeout: <settings.codexTimeoutMs>,
  maxBuffer: <十分な値>
})
```

- **stdin** でプロンプトを渡す（A-1）
- **`--add-dir` は原則不要**（A-2 実測）
- **CODEX_HOME を隔離**し、認証はそこで一度だけ用意する（A-3）
- **exit code を成功判定に使わない**（C-3）
- **トークンは `turn.completed.usage` から Event Log へ**（B-4）
- **MCP 事前検証は段階1の完了後**（E）

---

# 実装スコープ（承認後）

## 段階1-1: 起動と回収

- `src/engine/executors/codex.ts` をスタブから実装
- `ExecutorResult` に `failureKind` を追加、`ExecutorRequest` に optional 3つ（C-4）
- JSONL の保存（`runs/codex/`）と Event Log への要約転記（B-1 / B-4）
- `settings.codexHome` / `settings.codexTimeoutMs` を `types.ts` へ追加

## 段階1-2: 防衛線（**同一コミット**）

- 故障注入テスト 1〜8（課題G）
- 型分離 `SessionSecret` / `SessionRef`（課題D）— 段階2 の前に置く

## 段階1-3: 実運用の確認

- 実タスクを1本流し、BL-050 / BL-054 が pin 版 + 隔離 CODEX_HOME で再発しないか確認
- baseline に「M3 世代の開始」を記録（課題H）

## 段階2 / MCP は別コミット

段階1のトークン実測を見てから着手判定する。

---

# 実装の開始条件

すべて満たすまで実装に入らない。

| # | 条件 | 現在 |
| --- | --- | --- |
| 1 | `npm test` が 100/100 | ✅ 100/100（Stage 0 で修正） |
| 2 | pin 済み（`@openai/codex@0.147.0` が devDependency） | ✅ |
| 3 | フラグ実測済み（pin した版で） | ✅ m3-design-inputs §4 |
| 4 | この設計文書が承認されている | ✅ 2026-08-18 承認 |
| 5 | 故障注入リスト（課題G）が合意されている | ✅ 2026-08-18 合意（**9 件**。#9 を追加） |
| 6 | タスク境界にいる | 実装着手時に確認 |
| 7 | **隔離 CODEX_HOME で `codex login` 済み** | ⬜ **未**（人間が実施する） |

⚠️ **7 が残っている。** 認証が無いと 401 で何も走らないので、
実装しても受け入れ確認（BL-050 / BL-054 の再発確認）まで到達できない。

**実タスク1本目は小さいものを選ぶ。** 環境系の問題はタスクの中身と無関係に出るため、
切り分けやすい題材にする。

---

# 決定ログ

**決めたことはここへ追記する。** decision の置き場を一元化し、
「どこかの会話で決まったが文書に無い」を作らない（M2 レビューの「出所不明の追加」と同じ轍）。

| 日付 | 論点 | 決定 | 根拠 |
| --- | --- | --- | --- |
| 2026-08-18 | 隔離 CODEX_HOME の配置 | **`.ai-workflow2/.codex-home/`** | `tools/aiw` は公開予定リポなので避ける。runtime 状態は runtime に置く。バックアップリポの `.gitignore` に理由付きで `/.codex-home/` を追加 |
| 2026-08-18 | 認証の用意方法 | **隔離 home で `codex login` を1回**（人間が実施） | 複製は陳腐化するうえ「どちらが正か」が曖昧になる。**KI-01 の認証版**になる |
| 2026-08-18 | 故障注入リスト | **9 件**（#9 を追加） | exit 0 + 成果物なしは実測された実在の失敗モード |

---

# 未解決の論点（判断を委ねる）

いずれも**実装しながら決めてよい**。⚠️ **決めたらこの表から決定ログへ移す。**

| # | 論点 | 選択肢 | 私の傾き |
| --- | --- | --- | --- |
| 1 | **タイムアウトの既定値** | implementation は実測 5.5〜10.7 分、fix は 2.1〜9.6 分 | **30 分**（実測の3倍。長すぎると無人運転で気付かない、短すぎると正常なタスクを殺す） |
| 2 | `--approve-for-me` を付けるか | 付ける / 付けない（昇格が要る操作は失敗させる） | **付ける**。ただし「何が承認されたか」は JSONL に残るので事後に確認できる |
| 3 | **`aiw exec` の既定 executor をいつ切り替えるか** | 段階1完了と同時 / 数タスク並行運用してから | **並行運用してから**。`workflow.yaml` の `executor` は step ごとに指定できるので、implementation だけ先に切り替える手もある |
| 4 | JSONL の保持期間 | 無期限 / タスク完了時に archive へ / N 日で削除 | **archive へ退避**（`runs/` は既に 2.2 MB。JSONL はそれより大きくなる） |
