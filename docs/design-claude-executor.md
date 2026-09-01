# claude executor 設計（M4）

**状態**: **確定**（2026-08-31。課題A〜G 承認 → 委任判断・claudeModel・BL-071・effort まで
全件決着。未解決の論点 0 件）。実装の開始条件は別表——**人間側の項目が未のため実装は未着手**。

> 訂正の経緯は消さない方針（2026-08-31 承認時の指示）: 課題B の baseline 挙動と
> report 根拠は「初版は誤り、実装確認で訂正」の形をそのまま残している。

**目的**: review / improve-check / reflection / research の手貼りを消す。
プロンプトの組み立てから Claude の実行、成果物の回収までを `aiw exec` の中で完結させる。
M4.4（Canonical Primitive を抽出するかの判定）の手順もここで定める。

**参照実装**: `docs/design-codex-executor.md` と `src/engine/executors/codex.ts`（M3）。
本文書は codex 設計と同じ構造で書く。M3 で確定した判断は「前提」として引き継ぎ、再検討しない。

## 前提（確定済み・再検討しない）

| # | 前提 | 出典 |
| --- | --- | --- |
| 1 | **プロセス毎起動・fresh session 固定**。resume は作らない。再検討条件は「`cacheRead / input` 中央値 < 80%」 | M3 課題D（cacheRead 93.9%・n=20。コストの支配項は往復回数で resume では減らない） |
| 2 | **具体実装として書く**。codex.ts と共通化しない。抽象化の判定は M4.4 で2実装が揃ってから | M3 前提5 / 計画 M4.3-4.4 |
| 3 | **validator は1つも変更しない**。diff-scope の非対称・verify-local・三値・skipped の可視化すべて不変 | CLAUDE.md 不変条件4 |
| 4 | **clipboard へのロールバック可能性を維持**。ステップ単位で切り替え、drive の y/n 確認を Claude 側ステップにも同じ形で | CLAUDE.md 不変条件5 / M3 drive 段階1 |
| 5 | **pin と隔離**: 実行系は devDependency で `--save-exact`。設定・認証は aiw 専用ディレクトリに隔離し、ユーザーの Claude Code 設定に一切書かない。**最初の probe から隔離する** | M3 A-3（codex の probe がアプリの config.toml を汚した実測） |
| 6 | **生 session ID をログに残さない**。`SessionSecret` / `SessionRef` の型分離（`src/engine/session.ts`）をそのまま流用 | CLAUDE.md 不変条件6 / M3 課題D |
| 7 | **「強制: なし」3項目への防衛線**（kill→成果物から fresh 再実行 / 生 ID grep / 契約再記述なし）を executor 実装と同一コミットに含める | M3 課題F |

> **KI 番号の注記**: M4 指示文中の「KI-10」「KI-11」は `docs/aiw-known-issues.md` に
> 未採番である。内容から KI-10 = KI-09 系譜 #9（model-policy.json が未参照）、
> KI-11 = 系譜 #11（consumer-presence の root 解決）を指すと解釈し、
> 本文書では系譜番号で参照する。

---

# 調査結果（実測）

すべて **2026-08-31**、pin 済み **`@anthropic-ai/claude-code@2.1.251`** と
**`@anthropic-ai/claude-agent-sdk@0.3.251`** で実測。
probe はスクラッチパッド配下の使い捨て git リポジトリに対し、
**最初の1回から `CLAUDE_CONFIG_DIR` を隔離ディレクトリへ向けて**実行した（前提5）。
probe 前後でユーザー側 `~/.claude/`・`~/.claude.json` の mtime が**一切変化していない**ことを確認済み
（probe 前スナップショットとの突き合わせ。`~/.claude.json` 12:23:59 のまま）。

認証はしていない（login は人間の作業・開始条件へ）。したがって
**API 呼び出しを伴う挙動（実応答・トークン実測・許可リストの実地強制）は未実測**で、
「認証後スモーク」として開始条件・故障注入に積んである。それ以外はすべて実測。

## 1. 実行系の現状と更新速度

| 事実 | 実測値 |
| --- | --- |
| 手元の実体 | デスクトップアプリ管理の `claude.exe` 2.1.247（253 MB、`AppData\Local\Packages\Claude_…\LocalCache\Roaming\Claude\claude-code\<version>\`） |
| その保持数 | **直近2版のみ**（2.1.246 / 2.1.247。古い版は消される） |
| npm の `latest` | CLI **2.1.251** / SDK **0.3.251** |
| 更新頻度 | **CLI・SDK とも直近3ヶ月（06-01〜08-28）で 82 リリース = 平均 1.1 日に1回** |
| 版の対応 | SDK 0.3.N ↔ CLI 2.1.N の **lockstep**（環境実測: SDK 0.3.247 と CLI 2.1.247 が同居） |

codex の 4.6 日/回よりさらに速い。**pin は生命線**（M3 §4-2 と同じ結論がより強い形で成立）。
アプリ管理ディレクトリはバージョン番号付きだが直近2版しか残らないため、
そこを spawn するのは `.sandbox-bin` と同じ誤り。

pin の実体:

| 項目 | 値 |
| --- | --- |
| 入れ方 | `tools/aiw` の devDependency（`npm i --save-exact -D @anthropic-ai/claude-code@2.1.251`） |
| 実行パス | `node_modules/@anthropic-ai/claude-code/bin/claude.exe`（**208 MB のネイティブ exe**） |
| 起動方法 | `.exe` なので **shell 無しで直接 spawn できる**（codex の「.cmd は shell 必須 → JS シムを node で叩く」迂回は不要） |
| Node 依存 | **無し**（exe が自己完結。下記 Volta の罠を CLI は踏まない） |

⚠️ **Volta の罠（probe で実測）**: SDK の `sdk.mjs` を volta pin の無いディレクトリで
`node` 実行すると、Volta の既定 node **14.17.4** が使われ `??=` で SyntaxError になった。
aiw 自身は volta pin（20.19.0）があるので動くが、**SDK 案は「どの node で動くか」という
依存軸を1本増やす**。CLI（exe）はこの軸を持たない。

## 2. 設定・認証の隔離（`CLAUDE_CONFIG_DIR`）

**`CLAUDE_CONFIG_DIR` 1本で完全に隔離できる**（codex の `CODEX_HOME` + `--ignore-user-config` に相当）。

| 実測 | 結果 |
| --- | --- |
| 隔離 dir を指定して `-p` 実行 | `.claude.json`・`projects/<slug>/<sessionId>.jsonl`（transcript）・`backups/` が**すべて隔離 dir 内**に生成 |
| ユーザーの `~/.claude.json` | **更新されない**（mtime 不変。ここは codex の `config.toml [projects]` 追記と同型の「プロジェクト登録簿」であり、隔離しなければ実行のたびに汚れるはず） |
| ユーザーの `~/.claude/` | **更新されない**（settings.json / projects/ とも mtime 不変） |
| `claude auth status`（隔離 dir で） | `loggedIn: false` — **認証の参照も config-dir スコープ**。デスクトップアプリで login 済みでも隔離側は未認証 |
| `--no-session-persistence` | transcript が**生成されない**（実行前後で jsonl 件数不変）。`--ephemeral` の相当品 |

認証: `claude auth login`（`--claudeai` 既定 / `--console` / `--sso`）。
**隔離 dir で人間が1回 login する**（M3 A-3 の決定をそのまま適用。credentials を AI に触らせない）。
⚠️ Windows で資格情報が隔離 dir 内のファイルに閉じるか（OS の資格情報ストアを共有しないか）は
**login 時にしか確認できない**ため、開始条件の確認項目にする
（確認方法: login 後に隔離 dir 内の生成物を列挙し、デスクトップアプリ側の認証状態が不変であること）。

## 3. 非対話モードの出力（`-p --output-format stream-json`）

`--verbose` 併用で JSONL がストリームされる。認証なし実行1回の実測:

```text
{"type":"system","subtype":"init","session_id":"513affec-…","tools":[…26個…],
 "model":"claude-opus-5[1m]","permissionMode":"default","claude_code_version":"2.1.251",
 "slash_commands":[…46個…],"skills":[…18個…],"plugins":[],"apiKeySource":"none",…}
{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
 "text":"Not logged in · Please run /login"}],…},"session_id":"513affec-…",
 "error":"authentication_failed","is_api_error_message":true}
{"type":"result","subtype":"success","is_error":true,"api_error_status":null,
 "terminal_reason":"api_error","result":"Not logged in · Please run /login",
 "usage":{…cache_read_input_tokens 含む…},"modelUsage":{},"permission_denials":[],…}
```

設計に効く観測:

| # | 観測 | 帰結 |
| --- | --- | --- |
| 1 | `system:init` に **tools 一覧・model・permissionMode・版** が出る | 起動直後に「どの制限で走っているか」を検証・記録できる（課題B/E） |
| 2 | `result` に `usage`（`cache_read_input_tokens` / `cache_creation_input_tokens` 含む）と **`modelUsage`（実際に使ったモデル別の集計・`canonicalModel` 付き）** | **`modelObserved` が記録できる**。codex で不可能だった実測値記録が可能（課題E） |
| 3 | `result.permission_denials` が**ツール拒否の正本記録**（SDK 型定義に明記） | 「review が編集を試みて拒否された」が構造化データで残る（課題B/K） |
| 4 | assistant イベントに `error: "authentication_failed"` / `is_api_error_message` | 失敗分類の入力になる（課題F） |
| 5 | ⚠️ `result.subtype` は認証失敗でも `"success"`。**正は `is_error`** | subtype で成否を読まない |
| 6 | ⚠️ **生 session_id が init・全メッセージ・result・transcript ファイル名に出る** | redact 対象の経路が codex（thread.started のみ）より多い（課題E / 防衛線2） |
| 7 | 認証失敗の exit code は **1**（codex の 401 は 5 回リトライ後 exit 1 だった。こちらは即時） | 分類には使えるが、**成功判定に exit code を使わない規律は維持**（成果物の当否は validator） |

## 4. プロンプトの受け渡し

| 実測 | 結果 |
| --- | --- |
| stdin へパイプ + `-p`（引数プロンプトなし） | **読まれる**（プロンプトを消費して API 呼び出しへ進んだ） |
| 空 stdin + 引数なし | `Error: Input must be provided either through stdin or as a prompt argument when using --print`（**明確なエラー**。黙って空で走らない） |

**stdin を採る**（codex A-1 と同じ判断・同じ理由）。argv 上限は今日なら通るが、
プロンプトの成長が機能に影響しない構造にする。

## 5. ツール制限（課題Bの機構）

| 実測 | 結果 |
| --- | --- |
| `--tools "Read,Grep,Glob"` | `init.tools` が **正確に `['Glob','Grep','Read']` の3つへ縮小**。ツールがそもそも定義されない（呼びようがない） |
| `--restricted` | Bash / PowerShell / WebFetch は消えるが **Edit / Write が残る** — review 用途には不足 |
| SDK の `tools: [...]` | CLI と**同一の結果**（`init.tools` 一致を実測） |
| `--permission-mode` の選択肢 | `acceptEdits / auto / bypassPermissions / manual / dontAsk / plan` — **`dontAsk`（未許可は問い合わせず自動拒否）が無人実行の要** |
| `--allowedTools` / `--disallowedTools` | パターン形式（例 `Bash(git *)` / `Edit`）。**強制の実地確認は API 呼び出しが要る**ため認証後スモークへ |

拒否の記録は `result.permission_denials`（§3 観測3）。
「拒否された事実が残る」までが機構で担保される。

## 6. 暗黙の入力の遮断（課題Dの機構）

| 手段 | 実測 / 根拠 | 評価 |
| --- | --- | --- |
| 隔離 `CLAUDE_CONFIG_DIR` | §2 実測 | ユーザーの settings / skills / commands / hooks / CLAUDE.md（user メモリ）を構造的に読めない |
| `--setting-sources ""` | フラグは受理される（実測）。SDK 型 doc に「**CLAUDE.md の読み込みには `project` ソースが必須**」「`[]` で filesystem settings を無効化」と明記 | **プロジェクト CLAUDE.md（親リポ `.claude/CLAUDE.md`）の遮断手段**。混入なしの実地確認は認証後スモーク（marker 方式）で行う |
| `--strict-mcp-config` | ヘルプに「`--mcp-config` 以外の MCP 設定をすべて無視」 | `.mcp.json` 等の混入を遮断 |
| `--tools` から `Skill` / `Task` を外す | §5 実測（tools 集合が縮小する） | **同梱 skills を呼べなくする**。pin CLI は隔離 home でも組み込み skills 18 個・slash_commands 46 個を持つ（実測）——設定の隔離だけでは消えない点に注意 |
| `--disable-slash-commands` | ヘルプ（「Disable all skills」） | 上と重ねる保険 |
| `--no-session-persistence` | §2 実測 | transcript を残さない（fresh 固定と整合） |
| env のサニタイズ | **この設計セッション自身の env に `ANTHROPIC_BASE_URL` / `CLAUDECODE` / `CLAUDE_CODE_*` が実在した**（Claude Code 配下で aiw が動く場合に必ず起きる） | executor は子プロセス env を**許可リスト方式**（渡す変数を列挙）で構築し、そこへ `CLAUDE_CONFIG_DIR` を足す。**親セッションの認証・接続先が子へ漏れる経路を塞ぐ**（拒否リストでは知らない変数名を塞げない） |
| `--bare` | ヘルプ（CLAUDE.md 自動探索・hooks・plugins・keychain をすべて省く最小モード） | **採らない**。認証が `ANTHROPIC_API_KEY` 限定になり（OAuth を読まない）、隔離 home での subscription login と両立しない |

## 7. モデル・構造化出力ほか（フラグ面）

M4 に関係するフラグ（2.1.251 の `--help` 実測。全文は probe ログ）:

| 用途 | フラグ |
| --- | --- |
| 非対話 | `-p, --print` + `--output-format text|json|stream-json`（stream-json は `--verbose` 必須） |
| モデル | `--model <alias|full>`（**`init.model` に反映されることを実測**: `--model claude-sonnet-5` → `"model":"claude-sonnet-5"`）/ `--fallback-model` / `--effort low〜max` |
| 予算 | `--max-budget-usd`（-p 限定） |
| 構造化出力 | `--json-schema <schema>`（codex の `--output-schema` 相当） |
| セッション | `--no-session-persistence` / `--session-id <uuid>`（**こちらから UUID を指定できる**） |
| 制限 | `--tools` / `--allowedTools` / `--disallowedTools` / `--permission-mode` / `--restricted` |
| 隔離 | `CLAUDE_CONFIG_DIR`（env）/ `--setting-sources` / `--settings` / `--strict-mcp-config` / `--bare` / `--safe-mode` |
| ディレクトリ | `--add-dir <dirs...>` |
| system prompt | `--system-prompt` / `--append-system-prompt` / `--exclude-dynamic-system-prompt-sections` |

タイムアウトのフラグは**無い**。executor 側のタイマーで kill する（codex と同じ）。

## 8. effort の制御と観測（2026-08-31 追補・承認レビュー後の実測）

clipboard 時代の運用（モデル全ステップ Opus / effort は人間が難易度で low・high を使い分け）が
遡及記録されたことを受け、effort を設計変数として実測した。

| 実測 / 確認 | 結果 |
| --- | --- |
| CLI フラグ | **`--effort`（low / medium / high / xhigh / max）が存在し受理される**（2.1.251 の `--help` と実行で確認） |
| SDK | `Options.effort`（`EffortLevel` 型）が存在 |
| 実行時の観測 | **stream-json（init / assistant / result）のどこにも effort の実行時値は出ない**。`--effort low` での全出力を grep して、唯一の `"effort"` は slash_commands 内のコマンド名 `/effort` だった。SDK の `ModelUsage` 型にも effort フィールドは無い |
| downgrade | SDK 型 doc に「選択モデルに応じた **silent downgrade** の後の値が hook へ渡る」と明記——**指定値と実効値は乖離しうる** |
| env 経由の露出 | effort は hook と Bash へ **`CLAUDE_EFFORT` env var** として公開される。⚠️ この設計セッション自身の env に `CLAUDE_EFFORT=high` が実在した——**親セッションからの漏れ変数がまた1つ実証された**（§6 の許可リスト方式の必然性を補強） |

**帰結**: `effortObserved` は取れない。記録は **`effortRequested`**（指定値。未指定なら
`"unspecified"`）とし、実測と偽らない——`modelRequested` と同じ規律。
ただしモデルと違い **model は modelUsage で実測できる**ので、非対称は effort 側だけに残る。

## 9. 認証後スモーク（2026-08-31・隔離 home で login 後に実測）

人間が `.ai-workflow/.claude-home/` で `claude auth login` を完了（`--claudeai`）。
生成物は **`.claude.json` / `.credentials.json` / `backups/`** で、
**資格情報はファイルとして隔離ディレクトリ内に閉じた**（Windows 資格情報ストアは使われない）。
`/.claude-home/` は login 前に `.gitignore` へ追加済みで、`git check-ignore` で無視を確認。
ユーザー側 `~/.claude.json` は login 時刻（15:03）に更新されておらず（13:20 のまま＝別セッションの書き込み）、
`~/.claude/settings.json` も不変。**隔離は login まで含めて成立した。**

### 9-1. CLAUDE.md の遮断 ← **対照実験で成立を確認**

marker 入り `CLAUDE.md`（「読んだら XYZZY-M4 を返せ」）を置いた probe リポで:

| 条件 | 応答 | 判定 |
| --- | --- | --- |
| `--setting-sources` を**渡さない**（既定 = 全ソース読み込み） | **`XYZZY-M4`** | **漏れる**（テストに検出力があることの確認） |
| `--setting-sources ""` + `--strict-mcp-config` + `--disable-slash-commands` | `NONE` | **遮断成立** |

⚠️ 対照実験を先にやったのは「marker が出ない」が
**遮断の成功ではなくモデルが言及しなかっただけ**である可能性を潰すため
（KI-09 系譜 #11「テストがバグと共犯」の教訓の適用）。

### 9-2. permission rule の記法 ← ⚠️ **設計の初版は誤り。実測で訂正**

**初版の想定**: `--allowedTools "Write(<runtimeRoot>/**)"` で書き込み先を限定できる。

**実測（4 パターン）**:

| # | 与えたルール | runtimeRoot 内 | リポジトリ側 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `Read` のみ（Write ルールなし） | 拒否 | 拒否 | dontAsk は未許可を自動拒否する（想定どおり） |
| 2 | `Write(C:\…\.ai-workflow\**)`（**バックスラッシュ絶対パス**） | **拒否** | 拒否 | 記法が効いていない |
| 3 | `Edit(//c/…/.ai-workflow/**)`（**POSIX 絶対パス**） | **許可** | **拒否** | ✅ **これが正解** |
| 4 | `Write(//c/…/.ai-workflow/**)`（POSIX） | **拒否** | 拒否 | **`Write` にパスルールは効かない** |

確定した仕様（公式ドキュメントとも一致）:

- **`Write(path)` のパスルールは監視されない。** パス制限は **`Edit(path)` でのみ**成立する
- **Windows のパスは POSIX へ正規化される**。`C:\Users\…` → `//c/Users/…`。
  絶対パスのアンカーは **`//`**（`/path` は「設定ソースからの相対」という別の意味になる）
- `--permission-mode dontAsk` でも allow ルールは正しく評価される（#3 が許可された事実がその証拠）
- 拒否は `result.permission_denials` に**ツール名・引数・絶対パスまで**記録される（#1-#4 全件で確認）

⚠️ **`is_error: false` / exit 0 でも作業は行われていない**（#1・#4 は拒否されたが正常終了）。
codex の C-3（read-only 拒否でも exit 0）と**同じ性質が Claude でも成立する**。
成功判定に exit code を使わない規律はそのまま適用する。

### 9-3. ファイル単位の列挙と 0 バイトファイル ← **設計の締めに使った2つの実測**

`Edit` の許可を **`**` ではなく完全パス1本**にして測った:

| 確認 | 結果 |
| --- | --- |
| `Edit(//c/…/.ai-workflow/stub.md)` で `stub.md` を編集 | **許可** |
| 同じディレクトリの `marker.txt` を編集 | **拒否**（`permission_denials` に記録） |
| **0 バイトの `stub.md` を Edit で埋められるか** | **埋められた**（0 → 18 bytes・指定どおりの2行） |

**帰結**: 許可はディレクトリ単位である必要がなく、**成果物ファイルの列挙で足りる**。
かつ **0 バイトのスタブを置けば Edit の「存在」要求を満たせる**ので、
テンプレートの内容設計に依存せずに Edit-only を成立させられる（課題B の欠落ケースの解）。

### 9-4. modelObserved は**複数値**になる

全実行で `modelUsage` のキーが **`claude-opus-5` と `claude-haiku-4-5-20251001` の2つ**だった
（補助モデルが併用される）。`modelObserved` は単一値ではなく**キーの配列**として記録する。

## 10. Agent SDK（比較対象としての実測）

| 実測 / 確認 | 結果 |
| --- | --- |
| `query()` の smoke（隔離 env・認証なし・Node 20.19.0） | `system:init` → assistant → result を yield 後、**エラー結果で throw**（`Error: Claude Code returned an error result: Not logged in …`） |
| `tools: ["Read","Grep","Glob"]` | CLI と同一の縮小（実測） |
| 実行系の実体 | SDK が**自前の 208 MB バイナリを同梱**（`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`）。`pathToClaudeCodeExecutable` で差し替え可 |
| `settingSources` の既定 | 型 doc「**省略時は全ソースを読む**（CLI と同じ）。`[]` で隔離」——**隔離はオプトイン**であり、書き忘れれば混入する |
| `persistSession: false` | `--no-session-persistence` 相当（型 doc） |
| SDK 固有の口 | `canUseTool` コールバック（ツールコール単位の許可判定）/ `hooks` / `systemPrompt`（静的・動的境界マーカー付き配列）/ `mcpServers`（in-process MCP） |

---

# 設計課題ごとの選択肢

## 課題A: 実行手段の選定 ← **CLI（`claude -p`）を採る**

| 基準 | CLI（`-p` + stream-json） | Agent SDK |
| --- | --- | --- |
| 不変条件との一致 | プロセス毎起動・fresh・隔離が**フラグと env だけ**で成立（実測） | 同等に可能だが、`settingSources` 省略時は**全設定を読む**既定（隔離が「書いてあるから安全」になる） |
| 出力の回収 | stream-json の JSONL を **codex と同じ tee 方式**でそのまま保存（§3） | 同じ情報が取れるが、保存形式は自作になる（yield されたオブジェクトの再シリアライズ） |
| ツール制限の強制力 | `--tools` + `--permission-mode dontAsk` + `--allowedTools`（§5 実測） | 同等（`tools` で実測一致）+ `canUseTool` でさらに細かくできる |
| pin | **1層**（CLI パッケージの exe。Node にも依存しない） | **2層**（sdk.mjs + 同梱 exe）+ **Node 版依存**（Volta の罠を実測）|
| codex.ts との対称性 | **同型**: spawn（shell:false）+ stdin プロンプト + JSONL 1行ずつ読んで保存・要約・usage 抽出。M4.4 の比較が同じ土俵に乗る | in-process の async iterator。エラーは throw。構造が別物になる |
| 更新への追従 | CLI 単独で pin を上げる | SDK と CLI（同梱）を lockstep で上げる |

**CLI を採る。** 対称性のために劣った手段を選んだのではなく、
測った範囲で SDK 固有の利点（`canUseTool` / hooks / in-process MCP）が
**現段階の要件（静的な許可リストで足りる）に不要**だったため。
`canUseTool` が要る要件（例: Bash コマンドの動的判定）が実証されたら、
そのとき SDK への移行を再評価する——これが「SDK を選ばなかった判断の記録」であり、
M4.4 条件4（抽出しない判断の記録）と同じ形式で残す。

### A-1. 起動形態

- `spawn(<pin した claude.exe の絶対パス>, argv, { shell: false })`。exe なので直接起動できる
  （codex の「JS シムを node で叩く」迂回は**不要**。`claudeEntrypoint()` は exe パスを返すだけ）
- プロンプトは **stdin**（§4 実測。codex A-1 と同じ理由: argv 超過の失敗は遅く不明瞭）
- `-C` 相当は**無い**ため `cwd` オプションで渡す。値は `resolveCheckRepoRoot()`（codex A-2 の再利用。
  検査範囲と実行範囲を同じ値から導く）。runtimeRoot が外なら `--add-dir <runtimeRoot>`、
  解決不能なら起動しない（縮退規則も codex #8 と同じ）
- env: **許可リスト方式**で最小集合を列挙し、そこへ `CLAUDE_CONFIG_DIR=<隔離 home>` を足す（§6）

### A-2. 隔離 home の配置

codex A-3 の決定をそのまま写す:

| 項目 | 決定案 |
| --- | --- |
| 配置 | **`.ai-workflow/.claude-home/`**（`settings.claudeHome`、既定は runtime root 相対 `.claude-home`） |
| 認証 | **隔離 home で `claude auth login` を人間が1回**。credentials の複製はしない（KI-01 の認証版を作らない） |
| バックアップリポ | `.gitignore` へ理由付きで追加: `# 認証情報を含みうるため。バックアップ対象は知識であり credentials ではない。` `/.claude-home/` |
| 不在時 | executor は隔離 home が無ければ **permanent で起動拒否**し、login 手順を案内（codex と同文型） |

### A-3. pin の運用（2026-08-31 承認で追加）

- **pin を上げるときは、フラグ面の再実測を工程に含める**（M3 §4 と同じ規律）。
  更新速度が codex の倍（1.1 日/回）なので、pin 更新の間隔が空くほど flag 面の差は溜まる。
  再実測の対象は最低限: `--tools` の縮小挙動 / `--setting-sources ""` / `--permission-mode` の
  選択肢 / stream-json のイベント形 / `--no-session-persistence`
- Volta の罠（§1）は**環境固有の知識**なので `instructions/local-environment.md` へ記載する
  （本設計セッションで実施済み。CLI は exe なので踏まないが、この環境で node スクリプトを
  volta pin の外で動かす作業全般に効く）

#### ⚠️ 自動更新が pin を壊す（2026-09-02 実測）

`node_modules` に入れた `claude.exe` が、**自動更新によって
`claude.exe.old.<epoch ms>` へ改名されたまま放置された**。新しい実体は置かれず、
`bin/claude.exe` と `claude-code-win32-x64/claude.exe` の**両方が消えた**状態になっていた
（両者は同一 inode のハードリンク・217 MB）。発生は 2026-09-01 12:23、
気付いたのは翌日のリネーム作業中。**`npm ls` は正常を報告し続ける**ので、
バージョンの照合だけでは検出できない。

復旧はリネームで戻すだけでよかった（実体は無傷・`--version` が `2.1.251` を返した）。
再インストール（217 MB のダウンロード）は不要。

対策の候補（M4 実装時に決める。**まだ決めていない**）:

- executor が起動前に `claude.exe` の実在を確認し、無ければ
  `claude.exe.old.*` からの復旧を促して停止する（黙って落ちるより良い）
- `DISABLE_AUTOUPDATER=1` を executor が渡す env の許可リストへ入れる
  （課題D の env 許可リスト方式に1行足すだけ。**pin の意味を守るなら本命**）

⚠️ 開始条件の「pin 済み」は**一度満たせば終わりではない**。
実装着手時に `claude.exe` の実在と `--version` を確認すること。

## 課題B: review の修正権限を機構で強制する ← 本丸

clipboard 時代「review はコードを修正しない」は人間の規律だった。executor 化で機構に変える。
**三層**で守る:

1. **第1網: ツール集合の縮小**（`--tools`）——不要なツールはそもそも定義しない（§5 実測）
2. **第1網の裏打ち: 許可リスト**（`--permission-mode dontAsk` + `--allowedTools`）——
   残したツールの使い方をパターンで絞る。未許可は自動拒否され `permission_denials` に残る
3. **第2網: diff-scope**——第1網をすり抜けた変更・clipboard 運用時の変更を検査（後述）

### ステップ別の許可セット（提案）

⚠️ **§9-2 / §9-3 の実測により初版から2度変更**:
`Write` は**パス制限が効かないので `--tools` から完全に外す**（許可ルール無しで残すのではなく、
**ツールとして渡さない**——監視できないツールの存在自体が穴になる）。
書き込みは `Edit` で行い、**許可はディレクトリではなく成果物ファイルの列挙**にする
（`runtimeRoot/**` だと `state.json` / `runs/` / `config/workflow.yaml` / `skills/` まで
編集できてしまい、**エージェントがハーネス自身を書き換えられる**。最小権限から外れる）。

| ステップ | `--tools` | `--allowedTools` の Edit 対象（列挙） | Bash |
| --- | --- | --- | --- |
| **review** | `Read,Grep,Glob,Bash,Edit` | `current-review.md` / `current-status.json` の**2本のみ** | 下の列挙のみ |
| **improve-check** | `Read,Grep,Glob,Bash,Edit` | `current-status.json` の**1本のみ** | git 読み取り系のみ |
| **research** | `Read,Grep,Glob,Bash,Edit` | `context-package.md` / `codex-prompt.md` / `research-findings.md` / `current-status.json` の4本 | git 読み取り系 + 計測系 |
| **reflection**（M4 では自動化しない） | `Read,Grep,Glob,Edit`（**Bash なし**） | `context.md` / `learnings.md` / `backlog.md` / `task-metadata.json` / `current-status.json`（+ `research/` は唯一グロブが要る） | — |

- `Read` / `Grep` / `Glob` は無条件（読み取りは制限しない）
- パスは **executor が解決済み絶対パスを POSIX へ正規化して**組み立てる
  （`C:\…` → `//c/…`。相対だと cwd 依存になり、cwd は checkRepoRoot なので runtimeRoot と一致しない）
- **列挙の出どころは `workflow.yaml` の `steps.<id>.outputs`**。executor が読んで組み立てるので、
  許可リストを別に手書きしない（契約の二重管理を作らない・F-3 と同じ論理）。
  `optionalOutputs` も含める（ac-* は codex 側なので実質 Claude 側では効かないが、規則を分けない）

### Edit-only の「存在」要求 ← **0 バイトスタブで解く**（2026-08-31 確定）

Edit は対象ファイルの存在を要求する。ステップごとの成立状況:

| ステップ | 出力 | 存在源 | 成立 |
| --- | --- | --- | --- |
| review | current-review.md | restoreTemplates | ✅ |
| review / improve-check / research | current-status.json | 前ステップの出力が残る（improve-check Skill が「step を書き直せ」と言うのはこのため） | ✅ |
| research | research-findings.md | restoreTemplates | ✅ |
| research | **context-package.md / codex-prompt.md** | restoreTemplates の対象外。前タスクの残骸があれば存在するが、**`aiw init` 直後の新環境には無い** | ⚠️ 要対処 |
| reflection | **task-metadata.json** | `discardTaskMetadata` が毎回削除する（意図的） | ⚠️ 自動化時に要対処 |

**採用: 遷移確定時にエンジンが 0 バイトのスタブを作る**（`captureIfAbsent` と同じフック位置・
同じ「無ければ作る」形）。Edit が要求する**存在はエンジンが保証**し、**中身の検証は
contract / token-range が担う**という分担にする。

**却下した案: `templates/` へ追加して restoreTemplates に載せる。**
理由は**実測で穴が見つかったから**——`artifact-contract` は `checkMarkdownSections` で
**見出しの存在しか見ない**（`validators.ts`）。したがって必須見出しを備えたテンプレートは
**契約を自力で満たす**。`codex-prompt.md` には `token-range` が無い（掛かっているのは
`context-package.md` だけ）ので、**書かれなくても通ってしまう**。
これは `task-metadata.json` で踏んだ形そのもの（`discardTaskMetadata` のコメントが警告している罠）。

0 バイトが優れている点:

| 観点 | 0 バイトスタブ | テンプレート復元 |
| --- | --- | --- |
| `file-exists` | 通る（どちらも同じ。**存在を作る以上これは避けられない**） | 通る |
| `artifact-contract` | **落ちる**（見出しゼロ）→ halt | **通ってしまう**（見出しを含むため） |
| `json-schema`（current-status.json 等） | **落ちる**（パース不能）→ halt | 内容次第 |
| テンプレート内容への依存 | **無い** | ある（見出しを足すと穴が開く） |

⚠️ **「素通り」が構造的に起きないのが要点。** どちらの案も file-exists は通してしまうが、
0 バイトは**直後の contract で必ず止まる**。安全網が1枚減るのではなく、**担当が移る**。

実装メモ:

- 置き場所は `completion.ts` の遷移確定時（`captureBaselineFor` の隣）。**postActions には入れない**
  （resume で再実行されうる。baseline と同じ理由）
- **「無ければ作る」だけ**（`captureIfAbsent` と同型）。既存ファイルは絶対に上書きしない——
  reject → rerun で書き上げた成果物を消さないため
- 対象は**遷移先 step の `outputs` のうち存在しないもの**。宣言から導くので手書きリストを持たない
- ⚠️ **`executor` は関与しない**。「executor は成果物を検証しない / 用意しない」を保つ
- Event Log に `stub.created`（作ったファイル名）を残す。黙って作らない

### review の Bash 許可リスト（列挙の初版）

過去の review が実際に行った操作（行高実測・`dotnet build --artifacts-path` での新バイナリ検証・E2E 実行）を許し、
編集系を禁じる:

```text
Bash(git diff:*)  Bash(git status:*)  Bash(git log:*)  Bash(git show:*)
Bash(dotnet build:*)                          # --artifacts-path artifacts/e2e 前提(local-environment)
Bash(dotnet run:*)                            # e2e 用 backend の事前起動(--no-build)
Bash(./tools/nrun.cmd:*)                      # build / test / test:e2e
Bash(curl:*)                                  # readiness 確認
Bash(od -c:*)  Bash(certutil -dump:*)         # BL-071: 生バイト検査(候補。確定は実装時)
```

**E2E は「実行は許可、spec の作成は禁止」**（2026-08-31 承認）。
review の価値の実例（行高 27px→138px の実測）は E2E 実行から来ているため実行は許す。
一方「一時 spec を書いて測る」は Write を伴うので②（Write/Edit の runtimeRoot 限定）が禁じる。
**review が独自の計測コードを必要とする状況は、書いて測るのではなく
NOT VERIFIED か Manual Verification Required として記録する**——Reviewer が Builder になる
経路を塞ぐのが本質。この規律は review Skill へ追記する（実装スコープ段階1-3）。
`dotnet build --artifacts-path` のような成果物書き込みは、出力先が ignore 済みなら
diff-scope が黙認し、そうでなければ report が出る——そのままでよい。

⚠️ **複合コマンドの実測課題**: local-environment の backend 事前起動手順は `Start-Job` を含む
複合 PowerShell 1ブロックで、プレフィックスパターンに収まらない可能性が高い。
`Bash(powershell:*)` のような広い許可は第1網を骨抜きにするので**却下**。進め方:
初版は上の列挙で出し、**拒否は `permission_denials` で観測できる**ので、実運用で複合ブロックが
拒否されたらヘルパースクリプト化（固定パス1つを許可）を導入する。
「動かして分かる」が拒否の可視化によって成立している。

**BL-071 はここで消化する**（Trigger「文字化け検査コマンドを review に追加するとき」が発火）。
許可リストに生バイト検査コマンドを含め、手順は review Skill 側へ足す（契約の正本は workflow.yaml、
手順は Skill、という既存の分担どおり）。

### 第2網: diff-scope の二重化 ← **置く（report で）**

review ステップへ `diff-scope` を宣言する:

```yaml
- type: diff-scope
  onViolation: report
  declaredFilesFrom: context-package.md
```

**両方置く正当化**（BL-113 手順3「別の故障モードを塞ぐ」と同じ論理）:

| 網 | 塞ぐ故障モード |
| --- | --- |
| 第1網（ツール制限） | executor 経由の実行で、エージェントが編集を試みる |
| 第2網（diff-scope） | **clipboard へ戻した運用**（人間+対話AIが誤って直す）/ 許可リストの穴（Bash 経由の書き込み等）/ 将来の設定退行 |

第1網は executor 経路にしか効かない。不変条件5（clipboard へ戻せる）を維持する以上、
**戻した先にも網が要る**——これは複製ではない。

**baseline の挙動**（`completion.ts` の実装から確認・2026-08-31 レビューで初版の誤りを訂正）:
capture のトリガーは「**遷移先 step が diff-scope を宣言していれば遷移確定時に
`captureIfAbsent({step, fixAttempts})`**」というエンジン規則であり、キーは `(step, fixAttempts)`。
review に宣言を足せば **implementation→review の遷移確定時に baseline が取り直され、
review 中の変更だけが違反として観測される**。implementation の正当な変更は review の
baseline に吸収されるため、誤帰属は起きない。同一 `(step, fixAttempts)` では取り直さないので、
承認 reject→rerun の窓では初回 review の変更が rerun でも違反として持続する（意図どおり）。

⚠️ **残る盲点は1つだけ、明記する**: `declaredFilesFrom` は省略しても
`context-package.md` に既定される（`validators.ts`）ため、review の検査でも
**Modify 宣言済みファイルへの変更だけは違反にならない**。「宣言ゼロ」扱いにするには
validator の変更が要り、前提3（validator は1つも変更しない）で禁止。
review が最も触りたくなるのは正に Modify 集合内のファイルなので、
**この穴は第1網（ツール制限）が塞ぐ**。第1網が主、第2網は補助という関係はここから来る。
M4 後の改修候補として **BL-115**（diff-scope の「宣言ゼロ」モードで第2網を本物にする）を
起票済み（2026-08-31）。

`onViolation` を **report** にする理由: review 中の変更が review 自身の仕業とは限らない
（開発機では人間の VS・並走ビルドがファイルを触りうる）。halt にすると人間の並走作業が
無人運転を止める。report なら scope-violation-report.md と同じ経路で
人間の目（承認ゲート③）に届き、そこで帰属を判断できる。

### 拒否を成果物に残す（黙って失敗しない）

- `result.permission_denials` を executor が Event Log の meta へ**件数と対象ツール名で**転記する
  （全文は runs/ の JSONL にある。Event Log は観測の記録・B-1 の規律どおり）
- 進行表示（onProgress）にも `denied: <tool>` の1行を流す
- 書けずに終われば `file-exists` が halt し、denials が原因を語る——
  「エージェントが黙って諦めて exit 0」でも観測が残る

## 課題C: 段階制の順序 ← **improve-check → review → research。reflection は M4 では自動化しない（推奨）**

| 順 | ステップ | 根拠 |
| --- | --- | --- |
| 1 | **improve-check** | 契約が最も明確（出力は current-status.json 1つ・二値判定・修正しない）。失敗しても invalid-status で halt するだけで壊すものが無い。ツール制限の疎通確認に最適 |
| 2 | **review** | 本丸。直後に承認ゲート③があり**人間が current-review.md を必ず読む**——自動化の失敗を人間が見つける構造が既にある。第1網・第2網の実地検証はここで行う |
| 3 | **research** | 最も重く（実測139分）、halt 遷移（ux-decision-required）の確認が要る。②の承認ゲートがあるため失敗は見える。ただし下記の「対話性の喪失」の論点がある |
| — | **reflection** | **M4 では自動化しない**（下記） |

### reflection を M4 で自動化しない理由

1. **承認ゲートが無い**唯一の Claude ステップ。自動化の失敗が知識ファイル
   （context.md / learnings.md / backlog.md）を**静かに汚染**し、以後の全タスクの入力に混入する
2. 得られるのは **6分/タスク**。リスク（知識の汚染は発見が遅れ、遡って直すコストが大きい）と釣り合わない
3. M4 の主目的「手貼り消滅」は他3ステップで大半が達成される

**再検討条件**: M5（aiw auto）で無人ループに入れる必要が出たとき。
その場合は**知識ファイルの差分を人間に見せる軽い仕組みとセット**で入れる
（案: reflection 完了後、`.ai-workflow` バックアップリポの `git diff --stat` + 知識ファイル差分を
表示する postAction 相当の表示。バックアップリポは列挙式 .gitignore なので diff が取れる）。

### research の扱い ← **含める。ただし段階3、かつ条件付き**（2026-08-31 承認）

clipboard 運用の research は「人間が対話AIと検討しながら作る」ステップで、
実測139分の大半は人間の検討時間だった。executor 化は**この対話を消す**。
ux-decision-required で止めて人間が Open Decisions に書き込み再実行、という既存ループが
対話の代替になるが、往復の粒度は粗くなる。

- **improve-check と review が安定してから**着手する（段階3）
- **着手条件**: halt 系遷移（`ux-decision-required` と、invalid-status を含む停止経路）が
  「成果物ファイルを書いて止まる」ことを**故障注入で確認済み**であること
- drive の y/n（前提4）で従来運用へいつでも逃げられる形にし、
  数タスク並行運用で「検討の質が落ちるか」を見てから既定を切り替える

## 課題D: プロンプト組み立てと「暗黙の入力」の遮断

### 渡し方: 全 assembly を stdin の user message として渡す（分割しない）

- `assembleStepPrompt` の出力**そのもの**を stdin へ書く。executor は足さない・削らない・**分割もしない**
  （分割は「組み立ての再解釈」であり、組み立ての責務が2箇所に割れる。F-3 と同じ論理）
- system prompt は Claude Code の**既定 preset のまま**にする。
  既定 preset は pin（2.1.251）で固定され、版を上げない限り変わらない——再現性は pin が担保する。
  内容も汎用の動作指針であり、Artifact Contract の再記述にはあたらない
- `--system-prompt` / `--append-system-prompt` で instructions 部分を system 側へ移す案
  （m3-design-inputs §2 案(a)）は**段階1では採らない。ただしこれは選好ではなく
  再検討条件付きの決定**（M3 C1 と同じ扱い・2026-08-31 承認）:
  - 期待: codex 実測 93.9% は「全 assembly を user message で渡す」構造で出た値で、
    キャッシュは1実行内の往復（ツールコールごとの再送）で効いている。同構造なら Claude でも効くはず
  - **再検討条件: 認証後スモーク + 実タスク数本で `cacheRead / input` を実測し、
    中央値が 80% を下回ったら `--append-system-prompt` 分割（安定プレフィックスを system 側へ）を
    測って比較する**。80% は M3 の resume 再検討条件と同じ線
  - 分割するとしても `--system-prompt`（既定 preset の全置換）ではなく `--append-system-prompt` を使う。
    既定 preset のツール利用指針を消すと、挙動の変化がモデル起因か prompt 起因か
    切り分けられなくなる（世代比較の交絡を増やす）

### 遮断セット（§6 の実測に基づく確定案）

```text
CLAUDE_CONFIG_DIR=<隔離 home>          # ユーザー設定・skills・hooks・認証の分離
env は許可リスト方式で構築               # 渡す変数を列挙する(PATH / SystemRoot / TEMP 等の最小集合 +
                                        # CLAUDE_CONFIG_DIR)。拒否リスト(ANTHROPIC_*/CLAUDE_* を除去)に
                                        # しない——知らない変数名の漏れは拒否リストでは塞げない
--setting-sources ""                    # プロジェクト CLAUDE.md(.claude/CLAUDE.md)・settings.json の遮断
--strict-mcp-config                     # .mcp.json 等の MCP 混入遮断
--tools <ステップ別集合>                 # Skill / Task を含めない = 同梱 skills も呼べない
--disable-slash-commands                # 上の保険
--no-session-persistence                # transcript を残さない(fresh 固定)
```

**親リポの `.claude/CLAUDE.md` は aiw 開発用の不変条件であり、客先タスクの review に
注入されてはならない**。上記の `--setting-sources ""` がその遮断手段（SDK 型 doc 根拠・§6）。
実地確認は認証後スモークで行う: probe リポに marker 入り CLAUDE.md を置き、
「読めたら marker を出力せよ」で**混入が無いこと**を確認する（故障注入 K-6。probe 環境は作成済み）。

## 課題E: 出力の回収と計測

- **JSONL は `runs/claude/<stamp>-<step>.jsonl` へ tee**（codex B-1 と同方式・同規律:
  Event Log へは要約のみ、本文を入れない）
- 進行表示: stream-json のイベントを 1 行サマリへ（codex 課題I の `summarize` と同じ責務分担。
  `onProgress` 経由・バッファしない・生 session ID を含めない）。イベント対応:
  assistant の text → `message` / `tool_use`（Edit・Write・Bash）→ `edit` / `shell` /
  permission denial → `error` 系 1 行 / result → `tokens`
- **usage の転記**:

| stream-json (`result.usage`) | Event Log |
| --- | --- |
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `cache_read_input_tokens` | `cacheReadTokens` |
| `cache_creation_input_tokens` | `cacheWriteTokens` |

- **モデルは実測値が取れる**（§3 観測2）。両方記録する:
  - `meta.modelRequested`: `settings.claudeModel` の指定値（未指定なら `"unspecified"`。三値の規律）
  - `meta.modelObserved`: `result.modelUsage` の**キーの配列**。
    ⚠️ 実測では常に2つ（`claude-opus-5` + `claude-haiku-4-5-…`）だった——補助モデルが併用されるので
    **単一値のフィールドにしない**（§9-3）
  - 両方あるとき食い違えば Event Log にそのまま残る（検出は目視と将来の集計。halt はしない）
- 生 session ID: `SessionSecret` / `sessionSecret()` / `redactSession` を流用。
  **redact 対象の経路が codex より多い**（init・全メッセージ・result・transcript ファイル名。§3 観測6）。
  transcript は `--no-session-persistence` で作らせないので残るのは runs/ の JSONL のみ（codex と同じ扱い: 生値は一次資料にだけ残る）
- 新設 settings: `claudeHome` / `claudeModel` / `claudeTimeoutMs`（codex の3つと対に）+ 下記 effort

### effort（2026-08-31 追加・調査結果 §8）

clipboard 時代は「人間がタスク難易度で low / high を使い分け」ていた（遡及記録・課題H）。
この動的判断は executor で再現できないため、**静的宣言に置き換える**:

```yaml
settings:
  claudeEffort: low        # Claude 側ステップの既定
steps:
  review:
    effort: high
  research:
    effort: high           # 常時 high（下記）
  # improve-check / task-planning は既定の low が掛かる
```

- `steps.<id>.effort`（`WorkflowStep.effort` を型に追加）> `settings.claudeEffort` > 未指定
  （フラグを渡さない）。**配線とテストは同一コミット**（`model` / `timeoutMs` と同じ規律）
- **research を常時 high にする理由**: 「難しさを人間が判断して切り替える」は executor で
  再現できない。簡単なタスクを high で走らせるコストより、難しいタスクを low で走らせて
  research 起因の fix が回るコスト（M1 実測: fix 原因の research 起因 3/8）のほうが高い。
  安全側に倒す。**再検討条件**: research のトークンが問題になったら、task-planning に
  難易度を宣言させて effort を切り替える機構を検討する（今は作らない）
- 記録は **`meta.effortRequested`**（未指定なら `"unspecified"`）。
  `effortObserved` は取れない（§8 実測: 出力のどこにも残らない）うえ、
  モデルによる **silent downgrade** がありうるため、指定値であることを名前で明示する
- 世代注記（課題H）: effort の運用変化（動的 → 静的）が M4 世代の交絡の1つになる

### model-policy.json（KI-09 系譜 #9）← **削除を提案**

「宣言はあるが効いていない」を1つ減らす方向で、**エンジンが読むのではなく廃止する**:

1. 値が既に現実と乖離している（`implementation: codex / effort: medium` 以外の行は
   一度も実行を制御したことがなく、モデル名も alias のまま）
2. 実行を制御する宣言の正本は `workflow.yaml`（settings / step）という原則が既にある。
   同じ情報を別ファイルに持つと KI-01 型（同名で中身が違う）の変種になる
3. **ただし model-policy の「意図」（ステップ別モデル）は settings 側へ生き残らせる**
   （2026-08-31 承認: 「廃止」ではなく「正本を1箇所に統合する」が正確な表現。
   review と research で同じモデルとは限らない）

統合後の形:

- `settings.claudeModel` — Claude 側ステップの既定モデル（codex の `codexModel` と対）
- `steps.<id>.model` — ステップ別の上書き（`WorkflowStep.model` を型に追加）。
  **claude executor が `step.model ?? settings.claudeModel` で読む配線を同一コミットで入れる**
  （KI-05「型はあるがエンジンが参照しない」を新造しないため。テストも同コミット）
- codex 側は `settings.codexModel` のまま（前提「codex.ts の変更はしない」）。
  この非対称は M4.4 の比較表の1行になる

旧 CLI 経路 3 箇所の model-policy 参照も同コミットで整理し、
known-issues の系譜 #9 を「解消」へ更新する。

## 課題F: 失敗の分類とタイムアウト

分類の入力は **JSONL のイベント内容と exit code**（codex C-1 の規律を維持:
**成功判定には使わない**。成果物の当否は validator）:

| 観測 | 分類 | 根拠 |
| --- | --- | --- |
| assistant `error: "authentication_failed"` / result に「Not logged in」（実測） | `permanent` | 資格情報。再試行しても同じ |
| `api_error_status` が 401 / 403 | `permanent` | 同上 |
| `api_error_status` が 429 / 5xx、または retry 系メッセージ | `transient` | レート制限・過負荷 |
| タイムアウト（下記） | `transient` | KI-08 |
| spawn 失敗（ENOENT） | `permanent` | pin が壊れている |
| `subtype: error_max_turns` / `error_max_budget_usd` | `permanent` | 設定の問題。再試行で解けない |
| モデル拒否（refusal 系イベント） | `permanent` | 再試行で解けない。人間へ |
| exit 0 | 失敗ではない | 成果物の当否は validator が決める |

- **タイムアウト**: フラグが無いので executor のタイマーで `SIGTERM`。
  KI-08 の二重判定を同形で: `timedOut = timedOutFlag || signal !== null || durationMs >= timeoutMs`
- **既定値: 40 分**（`CLAUDE_DEFAULT_TIMEOUT_MS`。2026-08-31 承認）。根拠: review の
  実測中央値 13 分（監査項目追加後）の 3 倍。codex の「実測中央値 × 3 弱」と同じ決め方
- **ステップ別に上書き可にする**（承認時の条件）: research は AI 部分の所要が未実測のため。
  優先順は `req.timeoutMs` > `steps.<id>.timeoutMs`（`WorkflowStep.timeoutMs` を型に追加・
  課題E の `model` と同じく**配線とテストを同一コミット**で） > `settings.claudeTimeoutMs` > 既定 40 分

## 課題G: 承認ゲートと halt 遷移

- **承認ゲート②（research 後）・③（review 後）は人間のまま**。executor 化で変わるのは
  「プロンプトを貼る」だけ。`aiw run` の承認経路・exit code は不変（不変条件1）
- 止まる遷移はすべて「成果物ファイルを書いて終了」の形で**既に**成立している:
  `ux-decision-required`（research-findings の Open Decisions + current-status.json を書いて exit）/
  `fix-required`（current-review.md の Fix Scope）/ invalid-status の halt。
  `-p` は stdin をプロンプトとして消費して閉じるため**実行中の対話は構造的に存在しない**
  （§4: 空入力は即エラーになることも実測済み）
- ⚠️ 現行 workflow.yaml に `clarification-required` という遷移キーは無い
  （research の halt 系は `ux-decision-required` のみ）。指示文の同語は総称と解釈し、新設はしない

### review-audit の model-change トリガー ← 最小実装を同一コミットで

`auditPolicy.alsoSuggestOn: [model-change]` は現状 **KI-05（型はあるが未参照）**であり、
review を executor 化した瞬間 = モデル変更そのものなのに**発火しない**。宣言だけの機構を
そのままにしない:

- **最小実装**: `aiw run review` の完了時に、Event Log 上の**前回の review 実行**の
  `meta.executor` / `meta.modelRequested` と今回を比較し、異なれば
  「model-change: review-audit の実行を提案します」を表示 + `audit.suggested` イベントを記録する。
  提案のみ（起動はしない。counterOwner: cli の範囲内で、判定・遷移は変えない——不変条件1）
- 実装しない選択をするなら、`alsoSuggestOn` から `model-change` を**削除する**
  （KI-09 を増やさない）。⚠️ どちらにするかは承認時に確認。**傾きは最小実装**
  （M4 世代の Fix 率比較は review の検出力変化と交絡する〔課題H〕ため、
  audit がその検出力を測る唯一の手段になる）

## 課題H: 世代管理

- **M4 世代の開始を `docs/baseline.md`（親リポ・実在確認済み）へ記録**
  （最初の claude-executor タスクの日付・pin 版・切り替えたステップ）
- **Fix 率の比較には交絡注記**（M2 G-2 と同じ扱い）: review を executor 化すると
  review の検出力自体が変わりうるため、「M4 世代の Fix 率」と「M3 世代 25%」の差は
  実装品質の変化と検出力の変化を分離できない。注記なしで並べない
- **交絡の中身を訂正**（2026-08-31 の遡及記録により）: clipboard 時代の Claude 側は
  **モデル Opus で一貫**（人間の証言。`docs/baseline.md` の遡及注記 2026-08-31 として記録済み）。
  したがって交絡は「モデル不明」ではなく、
  **(1) 検出力（対話 → executor）と (2) effort の運用変化（人間の動的判断 → 静的宣言）**の2つ。
  `settings.claudeModel: claude-opus-5` で pin すればモデルは M3→M4 で不変になる
- **M3 世代の Fix 率 25%（n=20・CI ±19pt）を M4 前の基準値として固定**
- M4 世代の初期観察項目: 手貼り回数（review / improve-check で 0 の確認）/
  claude executor 失敗率（failureKind 別）/ `permission_denials` の発生数（第1網の発火実績）/
  cacheRead / input 比（Claude 側の初計測）

## 課題I: M4.4 — Canonical Primitive を抽出するか

**判定は claude.ts 実装後**。ここでは手順と比較表の形だけを定める。

判定手順:

1. codex.ts / claude.ts の**実装済みコード**から下の比較表を埋める（設計からではなく実物から）
2. 計画書の4条件で行ごとに判定する:
   (a) 2実装で実際に共通している (b) 両 Provider へ損失なくマップできる
   (c) 実行時に参照される (d) 抽象化後の方が設定量が減る
3. **4条件を全て満たす行だけ**を `ExecutorRequest` / 共通ヘルパーへ昇格する
4. 抽出しない行は理由を1行で記録する（**抽出しない判断も正当な結末**）
5. 結果はこの文書の決定ログへ追記する

比較表の形:

| 概念 | codex.ts の実装 | claude.ts の実装 | (a)共通 | (b)無損失 | (c)実行時参照 | (d)設定減 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 起動（spawn / shell:false / stdin） | | | | | | | |
| 隔離 home の解決と不在時拒否 | | | | | | | |
| cwd = checkRepoRoot / --add-dir 縮退 | | | | | | | |
| タイムアウト（二重判定・SIGTERM） | | | | | | | |
| JSONL の tee 保存 | | | | | | | |
| イベント要約 → onProgress | | | | | | | |
| usage → Event Log 転記 | | | | | | | |
| model の記録（requested / observed） | | | | | | | |
| session の型分離と redact | | | | | | | |
| failureKind の導出 | | | | | | | |
| ツール制限の宣言（claude のみ？） | | | | | | | |
| **失敗モード「正常終了だが作業なし」** | exit 0（read-only 拒否の実測） | `is_error: false` / exit 0（permission 拒否の実測） | ✅ **共通** | — | — | — | **抽象化ではなく規律として共通**: 成功判定に exit code を使わない。両 executor で必要だと実測で確定した（2026-08-31） |

⚠️ 先取りの注意: イベントの**語彙**は既に非対称（codex: `thread.started` / `item.*` /
`turn.completed`、claude: `system:init` / `assistant` / `result`）。「意味ベースの共通イベント型」は
条件 (b) を満たすか怪しい筆頭候補であり、**無理に共通語彙へ押し込まない**（計画 M4 完了条件）。

## 課題J: ついで枠（M4 実装が触る場所と同じ）

| 項目 | 内容 | 同枠の理由 |
| --- | --- | --- |
| **BL-114** | `consumer-presence` / `measurement-completeness` の宣言を `assets/config/workflow.yaml` へ移植し、test 88 系で固定。意図的差分（`executor: codex` 等の環境依存）は移植しない仕分けを添える | M4 で workflow.yaml の assets / runtime 両側を触る（Claude 側ステップの executor 宣言・diff-scope 追加） |
| **BL-071** | 生バイト検査コマンドを review の Bash 許可リストへ含め、手順を review Skill に追記 | 課題B の許可コマンド設計そのもの |

## 課題K: 故障注入（実装の完了条件として列挙）

| # | 注入 | 期待 |
| --- | --- | --- |
| 1 | review がファイル編集（リポジトリ側）を試みる | ツール制限で拒否。`permission_denials` に残り、Event Log の meta に件数が出る。**黙って失敗しない** |
| 2 | review がリポジトリを変更した（制限をすり抜けた想定。手でファイルを変えて模擬） | diff-scope（第2網）が report で検出し、承認ゲート③に見える |
| 3 | 実行途中で kill | 成果物ファイルから fresh 再実行で完走（防衛線1） |
| 4 | タイムアウト | `transient` として記録。`failed` に誤判定しない（KI-08 二重判定） |
| 5 | 生 session ID の grep | Event Log・表示経路・`aiw log` 相当の整形出力に生値 0 件（防衛線2。生値は runs/ の JSONL のみ） |
| 6 | CLAUDE.md / ~/.claude の混入 | marker 入り CLAUDE.md を置いた probe リポで「marker が応答に出ない」こと + 組み立て出力と送信内容の一致（stdin へ書いた本文の hash と assembly の hash が一致） |
| 7 | `executor: clipboard` へ戻す | 従来動作で完走（不変条件5） |
| 8 | 認証切れ（隔離 home の資格情報を退避） | `permanent` として記録し、再試行しない |
| 9 | exit 0 + 成果物なし | executor は成功を主張せず、`file-exists` が halt（codex #9 と同じ固定点。**このテストを消すこと自体が違反**） |
| 10 | reflection の許可セットでリポジトリ書き込みを試みる（M4 で自動化しない場合は設定のみのテスト） | Bash 不在 + Write/Edit の runtimeRoot 限定で拒否される |
| 11 | **BL-071 canary**: CP932 誤読だが UTF-8 valid な文字化けを含むフィクスチャ | 選定した生バイト検査コマンドが**実際にそれを検出する**（typecheck の canary と同じ方式）。Windows 環境で Claude CLI の Bash が動くシェルを確認し、そこで実際に通るコマンドを選ぶ。**これが review Skill へ手順を書く受け入れ条件** |

---

# 推奨案（まとめ）

```text
spawn(<pin した claude.exe の絶対パス>, [
  "-p",
  "--output-format", "stream-json", "--verbose",
  "--no-session-persistence",
  "--setting-sources", "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--permission-mode", "dontAsk",
  "--tools", <ステップ別集合>,      // ⚠️ Write は入れない（パス制限が効かない・§9-2）
  "--allowedTools", <ステップ別許可リスト>,  // Edit(//c/…) は POSIX 絶対パス
  ...(effort ? ["--effort", effort] : []),
  ...(model ? ["--model", model] : []),
  ...(addDir ? ["--add-dir", runtimeRoot] : [])
], {
  cwd: <checkRepoRoot>,
  env: { ...(許可リスト方式で列挙した最小 env), CLAUDE_CONFIG_DIR: <隔離 home> },
  shell: false,             // KI-08
})
// プロンプトは assembleStepPrompt の出力そのものを stdin へ（足さない・削らない・分割しない）
// タイムアウトは executor のタイマーで SIGTERM（既定 40 分・二重判定）
```

- 実行手段は **CLI**（課題A）。SDK は canUseTool 等の要件が実証されたら再評価
- ツール制限は **--tools + dontAsk + allowedTools + diff-scope(report)** の三層（課題B）
- 順序は **improve-check → review → research**、**reflection は自動化しない**（課題C）
- **modelObserved が記録できる**（codex との最大の観測差。課題E）
- model-policy.json は**廃止提案**（課題E）

---

# 実装スコープ（承認後）

## 進め方の規律（2026-08-31 確定・M3 と同じ）

- **この設計文書が正本**。段階ごとにコミットする
- **防衛線3つ（前提7）は executor と同一コミット**
- 故障注入（課題K・11件）は**実測報告**する
- **設計からの逸脱と未記述の判断は完了報告で明示する**（M3 の「実装時の決定」節と同じ形式。
  表を黙って書き換えない——「実装が設計を上回った箇所は上回ったと分かる形で残す」）
- **段階の切り替えは drive の y/n 確認を通し、切り替え後の最初の実タスクで
  validator の発火状況を見てから次段階へ進む**（improve-check → review → research の順は確定）

## 段階1-1: improve-check（起動と回収の疎通）

- `src/engine/executors/claude.ts` をスタブから実装（`createClaudeExecutor(deps)` 形式・codex と同型）
- `settings.claudeHome` / `claudeModel` / `claudeTimeoutMs` を追加
- JSONL の tee（`runs/claude/`）・usage / modelObserved の Event Log 転記・進行表示

## 段階1-2: 防衛線（同一コミット）

- 故障注入 3 / 4 / 5 / 8 / 9（プロセス系）+ 型分離の流用確認
- 生 ID grep テストの対象へ claude 経路を追加

## 段階1-3: review（本丸）

- review の許可セット + diff-scope 宣言（workflow.yaml 両側）+ BL-071 / BL-114
- review Skill へ追記: 「計測コードが必要なら書いて測らず NOT VERIFIED /
  Manual Verification Required として記録する」（E2E 決定の規律）
- review-audit の model-change 最小実装（課題G）
- 故障注入 1 / 2 / 6 / 7 / 10

## 段階1-4: research + 世代記録

- **着手条件**: 段階1-3 までが安定し、halt 系遷移が「成果物を書いて止まる」ことを
  故障注入で確認済みであること（課題C の承認条件）
- research の許可セットと並行運用開始。baseline へ M4 世代を記録（課題H）

---

# 実装の開始条件

すべて満たすまで実装に入らない。

| # | 条件 | 現在 |
| --- | --- | --- |
| 1 | `npm test` が全件 green | 実装着手時に確認 |
| 2 | pin 済み（`@anthropic-ai/claude-code@2.1.251` が devDependency・--save-exact） | ✅ 済（2026-08-31。人間が実施）。⚠️ **着手時に再確認すること**——自動更新で `claude.exe` が消えた実績あり（A-3 の追記）。2026-09-02 に復旧済み |
| 3 | フラグ実測済み（pin した版で） | ✅ 本文書「調査結果」（2026-08-31・2.1.251） |
| 4 | この設計文書が承認されている | ✅ **承認・確定**（2026-08-31。課題A〜G 承認 + 委任判断全件決着。未解決の論点 0 件） |
| 5 | 故障注入リスト（課題K・**11件** = 10件 + BL-071 canary）が合意されている | ✅ 済（2026-08-31。「7件」は設計プロンプト時点の初期数で、11 件が確定値） |
| 6 | 隔離 home（`.ai-workflow/.claude-home/`）で `claude auth login` 済み（**人間が実施**）。login 後、資格情報が隔離内に閉じ、デスクトップアプリ側の認証・設定が不変であることを確認 | ✅ 済（2026-08-31・§9） |
| 7 | 認証後スモーク: marker 方式の CLAUDE.md 混入なし確認 + allowedTools の実地強制確認（拒否が permission_denials に載る） | ✅ 済（2026-08-31・§9-1 / §9-2）。**設計の訂正1件を伴った**（Write → Edit） |
| 8 | `docs/baseline.md` のバックアップ済み（人間。親リポ未コミットの単一コピー） | 未（実在は確認済み・46KB。**遡及注記 2026-08-31 を追記済みなので、バックアップはその後に取ること**） |
| 9 | タスク境界にいる | 実装着手時に確認 |
| 10 | effort の制御可否の実測 | ✅ 済（調査結果 §8・2026-08-31。フラグあり / observed 取れず → effortRequested で記録） |

---

# 決定ログ

**決めたことはここへ追記する**（codex 設計文書と同じ運用）。

| 日付 | 論点 | 決定 | 根拠 |
| --- | --- | --- | --- |
| 2026-08-31 | 実行手段 | **CLI（`claude -p` + stream-json）**。SDK は不採用（再評価条件: canUseTool 等の動的判定が要件化したとき）。**承認済み** | 課題A の比較表。pin 1層 vs SDK は同梱バイナリ + Node 版の2層（Volta 罠実測）。pin 更新時はフラグ再実測を工程に含める（A-3） |
| 2026-08-31 | 三層防御（課題B） | **承認済み**。①`--tools` 縮小 ②`dontAsk`+許可リスト ③diff-scope **report**。baseline は review 入場時に取り直される（エンジン規則）。残る盲点は Modify 宣言済みファイルのみで第1網が塞ぐ | 課題B。BL-113 手順3の「別の故障モード」論理 |
| 2026-08-31 | E2E の権限 | **実行は許可、spec の作成は禁止**。計測コードが要る状況は NOT VERIFIED / Manual Verification Required として記録（review Skill へ追記） | Reviewer が Builder になる経路を塞ぐ。行高実測の価値は E2E 実行由来 |
| 2026-08-31 | 順序 | **improve-check → review → research（段階3・条件付き）**。research の着手条件は「halt 系遷移が成果物を書いて止まることの故障注入確認済み」。**承認済み** | 課題C |
| 2026-08-31 | **reflection は M4 では自動化しない**（実装しない判断） | clipboard のまま。**再検討条件: M5 の無人ループで必要になったとき、知識ファイル差分を人間に見せる仕組み（バックアップリポの diff 提示）とセットでのみ入れる** | 承認ゲートが無い唯一の Claude ステップ。知識汚染のリスクに対し利得 6分/タスク |
| 2026-08-31 | プロンプトの受け渡し | **stdin**。分割せず全 assembly を user message として渡す。system prompt は既定 preset。**再検討条件付き: 実測で `cacheRead / input` 中央値 < 80% なら `--append-system-prompt` 分割を測って比較する**（M3 C1 と同じ扱い） | §4 実測 / 課題D |
| 2026-08-31 | 隔離 | **`CLAUDE_CONFIG_DIR=.ai-workflow/.claude-home`** + `--setting-sources ""` + **env は許可リスト方式**（拒否リストにしない） | §2 / §6 実測。codex A-3 の適用 |
| 2026-08-31 | session の永続化 | **`--no-session-persistence` を既定にする** | fresh 固定と整合、かつ**生 session ID の露出経路を1つ消す**（transcript ファイル名）。JSONL は runs/ に tee するので隔離 home の transcript は冗長。grep テストの対象も減る |
| 2026-08-31 | model-policy.json | **正本を settings へ統合**（`settings.claudeModel` + `steps.<id>.model`、配線とテスト同一コミット）。model-policy.json は削除 | 課題E。KI-09 系譜 #9 の解消 |
| 2026-08-31 | タイムアウト | **既定 40 分 + ステップ別上書き**（`steps.<id>.timeoutMs`） | review 実測 13 分 × 3。codex（17 分→30 分）と整合。research は未実測のため上書き口が要る |
| 2026-08-31 | review-audit の model-change トリガー | **最小実装する**（前回 review の executor / model と比較して提案表示 + Event Log 記録）。**承認済み** | 課題G。「発火しない宣言」の解消。M4 世代の交絡を測る唯一の手段 |
| 2026-08-31 | `settings.claudeModel` の値 | **`claude-opus-5`** | **clipboard 時代の全ステップが Opus だった**（人間の証言・baseline.md 遡及注記）。pin の初期値でモデルを変えると M3→M4 の Fix 率比較に交絡が乗る。「固定する」と「変える」は別の判断（codex pin と同じ原則）。sonnet 等への切り替えは M4 世代安定後の実験（フェーズ×モデル比較の1行）として別途 |
| 2026-08-31 | BL-071 のコマンド | **実装時確定で承認。受け入れ条件付き**: CP932 誤読の UTF-8 valid 文字化けフィクスチャを作り、選んだコマンドが実際に検出することを確認してから review Skill に書く（故障注入 #11） | typecheck の canary と同じ方式。Claude CLI の Bash が Windows でどのシェルで動くかも確認してから選ぶ |
| 2026-08-31 | **permission rule の記法**（§9-2 実測で初版を訂正） | **パス制限は `Edit(path)` のみ有効。`Write(path)` は無視されるので `--tools` から Write を外す**。パスは POSIX 絶対（`//c/…`）。dontAsk でも allow ルールは評価される | 4 パターンの実測。バックスラッシュ絶対パスは効かず、`Write(POSIX)` も内外とも拒否された |
| 2026-08-31 | **Edit の許可範囲**（レビュー指摘で変更） | **ディレクトリではなく成果物ファイルの列挙**。列挙は `steps.<id>.outputs` から導く。`--tools` から Write を**完全に外す**（監視できないツールを渡さない） | `runtimeRoot/**` だと state.json / runs/ / workflow.yaml / skills/ まで編集でき、**ハーネス自身を書き換えられる**。§9-3 でファイル単位の列挙が効くことを実測 |
| 2026-08-31 | **Edit の「存在」要求の解**（レビュー案を採用） | **遷移確定時にエンジンが 0 バイトスタブを作る**（`captureIfAbsent` と同型・無ければ作るだけ・Event Log へ `stub.created`）。templates 案は**却下** | §9-3 で 0 バイトを Edit で埋められることを実測。templates 案は `artifact-contract` が見出しの存在しか見ず、`codex-prompt.md` に `token-range` が無いため**書かれなくても通る**（task-metadata と同じ罠）。0 バイトなら contract で必ず止まる |
| 2026-08-31 | 隔離の成立（login 後） | **確認済み**。`.credentials.json` は隔離ディレクトリ内に閉じ、ユーザー側 `~/.claude*` は login で更新されない。`/.claude-home/` は login 前に gitignore 済み | §9。codex（auth.json）と同じ性質が Claude でも成立 |
| 2026-08-31 | CLAUDE.md 遮断 | **`--setting-sources ""` で成立を実測**（対照実験で「遮断なしなら漏れる」ことも確認済み） | §9-1 |
| 2026-08-31 | effort | **静的宣言に置き換える**: `settings.claudeEffort: low` 既定 + `steps.review.effort: high` + `steps.research.effort: high`（常時）。記録は `effortRequested` のみ（observed は取れない・§8 実測）。**再検討条件**: research のトークンが問題になったら task-planning に難易度を宣言させる機構を検討 | clipboard 時代の「人間が難易度で使い分け」は executor で再現できない。research 起因 fix（M1 実測 3/8）のコスト > 簡単タスクを high で走らせるコスト。安全側に倒す |

---

# 未解決の論点（判断を委ねる）

**残り 0 件。**
経緯: 初版 8 件 → 承認レビューで 6 件決着 → 最終確定で claudeModel / BL-071 が決着 →
認証後スモーク（§9-2）で Edit-only の欠落ケースが 1 件生じ → **0 バイトスタブ方式で決着**（課題B）。

⚠️ この 1 件は「私の推奨（templates 案）が誤りで、レビューの指摘（スタブ案）が正しかった」形で
決着している。誤りの中身は**`codex-prompt.md` に token-range が無いことを確認せずに
『contract があるから空では通らない』と書いた**こと。経緯は課題B に残す。
