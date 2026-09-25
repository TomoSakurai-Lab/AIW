# aiw バックログ

**ここは `tools/aiw`（ワークフローエンジン自身）の課題を置く場所。**
アプリ本体の課題は `.ai-workflow/backlog.md`（runtime 側）にある。

## 2つある理由と、どちらに書くか

| | このファイル | `.ai-workflow/backlog.md` |
| --- | --- | --- |
| 対象 | エンジン・validator・Skill・プロンプト・aiw の文書 | アプリの機能・画面・仕様判断 |
| 置き場 | `tools/aiw`（**独立リポジトリ**。親では gitignore） | 親リポジトリの runtime（**親では gitignore**） |
| 誰が書くか | **人間 / エンジン改修枠**が手で書く | **reflection が自動で転記する** |

⚠️ **reflection はこのファイルを知らない。** `instructions/backlog-rules.md` が指す
`backlog.md` は runtime 側のみで、レビューの `## Backlog` は全てそちらへ入る。
**エンジンの課題が runtime 側に積まれるのは異常ではなく既定の動作**なので、
エンジン改修枠を開くときに runtime 側を見て、該当分をここへ移すこと。
「片方だけ見れば足りる」形にはなっていない。

移管の形は既に固まっている（2026-09-01 時点で **12 件**が移管済み）:
runtime 側の項目を消さず `Status: wontfix (tools/aiw/docs/backlog.md へ移管)` を残し、
中身をこちらへ写す。**runtime 側の行を消すと「無い＝存在しない」に見える**ので消さない。

⚠️ **ID は2ファイルで1つの番号系統を共有する。採番は両ファイルの最大 ID + 1。起票前に両方を grep すること**
（規則の正本は `instructions/backlog-rules.md`「採番」）。親リポジトリのルートで:

```bash
grep -ohE "BL-[0-9]+" .ai-workflow/backlog.md tools/aiw/docs/backlog.md | sort -t- -k2 -n | tail -1
```

見出しの並びは ID 順ではないので、末尾の見出しを最大値とみなさないこと。
過去に BL-103 で衝突し、**2026-09-17 に BL-114〜121 の 8 件で再発した**——規則は冒頭に書いてあったが、
採番時の検査が片側しか見ておらず、書き手の注意だけで守られていた。再発防止として backlog-rules へ宣言した。

### 振り直しの対応表（2026-09-17）

このファイルの BL-114〜121 はアプリ側と番号が衝突していたため BL-211〜218 へ振り直した。
**旧番号は過去のコミットメッセージに残っている**（書き換えられない）ので、履歴を読むときはこの表で引く。
アプリ側（`.ai-workflow/backlog.md`）の BL-114〜121 は元の番号のまま。

| 旧 | 新 | 件名 |
| --- | --- | --- |
| BL-114 | BL-211 | `consumer-presence` / `measurement-completeness` の宣言を assets へ移植 |
| BL-115 | BL-212 | review 用 diff-scope の「宣言ゼロ」モード |
| BL-116 | BL-213 | `templates/research-findings.md` が契約を自力で満たす |
| BL-117 | BL-214 | `aiw log` が `runs/claude/` を読めない |
| BL-118 | BL-215 | `context.md` の索引と見出しのドリフト検査 |
| BL-119 | BL-216 | review / improve-check の `bashAllow` に `cd:*` |
| BL-120 | BL-217 | 仕様根拠で許可した Bash コマンドの実測 |
| BL-121 | BL-218 | research 成果物が archive も削除もされない |

⚠️ **バックアップの単位が別。** ここは AIW リポジトリの履歴に残るが、
runtime 側は親リポジトリで gitignore されており **git に残らない**。
消えて困る判断は、runtime 側に置いたままにしない。

## BL-031

- Source: ユーザー指摘（ワークフロー運用）
- Severity: Minor
- Trigger: ワークフローエンジンの task-planning 入力を改修するとき
- Summary: `user-task.md` と `current-task.md` の近重複を解消する。入力の単一化、明白な単一タスクでの task-planning 簡略化、artifact contract の見直しを検討する。
- Status: open

## BL-063

- Source: TASK-2026-08-13-worktype-master / current-review.md ## Backlog 2
- Severity: Major (deferred)
- Trigger: e2e の変更申告と実体が食い違う事象が再発したとき
- Summary: git 管理外の e2e spec を `diff-scope` が検知できず、`Files Changed` の申告と実体を突き合わせられない。管理対象と validator の境界を見直す。
- Status: open

## BL-071

- Source: TASK-2026-08-14-hishou-undo-redo / current-review.md M4
- Severity: Minor
- Trigger: 文字化け検査コマンドを prompt または review に追加するとき
- Summary: U+FFFD 検査だけでは CP932 誤読後も valid UTF-8 になる文字化けを検出できない。壊れにくい明示リストまたはエスケープ表記と、生バイト確認の手順を定める。
- Status: **検査コマンド確定**（2026-09-04・M4 段階1-2 の事前計測。canary で受け入れ条件を満たした）。**残りは review Skill への手順追記のみ**（段階1-2）。実測は `docs/design-claude-executor.md`「実装時の実測」§5: U+FFFD のみの検査は 10 行の文字化けを **0 件しか検出しない**（主張の実証）。採用は「半角カナ域 + 化け漢字シグネチャ」の PCRE で、検出 10/10・偽陽性 0（`ok.txt` + 実ドキュメント 2,999 行）。⚠️ `(*UTF)` を付けないと exit 2、リテラル範囲 `[｡-ﾟ]` はロケール未設定の GNU grep 3.0 で**正常な日本語に誤ヒット**する。Claude CLI の Bash は MINGW64/Msys（PowerShell ではない）。

## BL-078

- Source: TASK-2026-08-18-m3-preflight / M3 前提の棚卸し
- Severity: Minor
- Trigger: reflection Skill を次に変更するとき
- Summary: `task-metadata.json` の `openDecisions` は reflection 時点の未解決件数を表す、と Skill で定義する。json-schema だけでは時点の意味を固定できない。
- Status: **done**（2026-08-30。reflection Skill v2 で metrics 各キーの出典を表で明文化。`openDecisions` は「reflection 時点で未解決のもののみ。実装中に解決済みは含めない。判別は research-findings と実装・review の記録の突き合わせ」と定義。`aiw status --summary` の消し込み前の値との時点差も明記）

## BL-082

- Source: TASK-2026-08-19-torikimegai-modonyu-shiro-haikei / current-review.md M1
- Severity: Major (deferred)
- Trigger: validator を次に変更するとき、または measurement completeness の未発火が再発したとき
- Summary: `ac-manifest.json` / `ac-result.json` が無いと measurement completeness validator が常に skipped になる。optional output を緩めず、計画ファイルを生成する側と未検査の可視化を直す。
- Status: open

## BL-088

- Source: TASK-2026-08-20-motodumori-adjustment-propagation / current-review.md ## Backlog
- Severity: Minor
- Trigger: `.cs` を変更するタスクの prompt または local environment 手順を更新するとき
- Summary: `--artifacts-path` を使う場合は build と run を同じ出力先へ通す定型に直す。run だけに指定すると成果物が無く起動できず、指定しないと DLL ロックを回避できない。
- Status: open

## BL-090

- Source: research/codex-self-analysis.md 提案2
- Severity: Minor
- Trigger: 既知の反例がある高リスク構造を research の Constraints に含めるとき
- Summary: 高リスク案ごとに、採用直後に実行する最小の反例テストと棄却値を context package へ記録する仕組みを追加する。
- Status: open

## BL-106

- Source: 旧 BL-101 / 2026-08-25 の Codex 安全停止 / KI-09 系譜 #10
- Severity: Major (deferred)
- Trigger: ソーク明けの最初のエンジン改修枠、または手動退避が維持できなくなったとき
- Summary: `ac-manifest.json` / `ac-result.json` を archive 対象と archive 後削除へ追加し、implementation Skill に前タスクの作業ファイルを確認なしで置き換えてよい旨を明記する。
- Status: **done**（2026-09-01。`archiveArtifacts` へ追加 + `discardAcArtifacts` + implementation Skill v3。2タスク連続の退避を test で固定）

## BL-107

- Source: 旧 BL-102 / KI-09 サブパターン「生成だけ配線して掃除を忘れる」
- Severity: Minor
- Trigger: 新しい artifact をワークフローへ追加するとき
- Summary: artifact 追加時の確認事項を、生成、contract、archive、restore-or-delete、分類表の5点チェックリストとしてテンプレート化する。
- Status: **done**（2026-09-01。`docs/new-artifact-checklist.md`。許可リスト・パス規約・2周目のテストを足して8点にした）

## BL-103

- Source: TASK-2026-08-27-hishou-filter-look / reflection
- Severity: Minor
- Trigger: reflection が backlog へ新規項目を採番するとき
- Summary: 採番前に既存 ID の重複を検査する。アプリと aiw の課題を別ファイルで管理し、同じ番号系統を共有して再衝突しないようにする。
- Status: open

## BL-105

- Source: TASK-2026-08-27-row-select / reflection
- Severity: Minor
- Trigger: invalid status の halt メッセージを次に変更するとき
- Summary: `current-status.json` の `result` が不正な場合、halt メッセージへそのステップの許可値を必ず列挙する。fix Skill / prompt にも許可値を明記する。
- Status: open

## BL-113

- Source: 2026-09-01 のエンジン修正枠で判明（`pathBase` 追加時）
- Severity: Minor
- Trigger: `ac-manifest.json` / `ac-result.json` の形を次に変えるとき、または `aiw init` を新環境へ配るとき
- Summary: `schemas/ac-manifest.schema.json` と `ac-result.schema.json` が **runtime にしか無く、どの validator からも参照されていない**。`aiw init` で配られないので新環境には存在せず、内容が壊れても誰も検知しない。`assets/schemas/` へ移すか、`workflow.yaml` の implementation へ `json-schema` validator を宣言するかを決める（宣言するなら `onViolation` の値も決める）。
- Status: **done**（2026-08-31。「参照する」方向で両方実施。implementation へ ac-manifest / ac-result、fix へ ac-result の `json-schema` validator を `onViolation: report` で配線し、schema は緩い版（必須+型のみ。enum は pathBase / status の実害枠だけ）へ差し替えて `assets/schemas/` から配布。**配線の前提条件として archive + root の実データ全件〔2ペア4ファイル〕が schema を通ることを先に確認した**（4/4 PASS。c-p の「テストがバグと共犯」の教訓の適用）。pathBase の許容値は schema enum（書き手向け契約）と `KNOWN_PATH_BASES`（実行時安全網）の両残しとし、test 124 が機械照合。不在の扱いは optionalOutputs 宣言から skipped、schema 不在は report→skipped / halt→failed。故障注入 4 件を実環境 config のクローンで実測済み。テスト 118-125 新設・全 141 green。**世代注記**: versions へ `schemas.acManifest: 1` / `schemas.acResult: 1` を新設し、`versionInfo()` を step の json-schema 宣言から動的列挙する形へ拡張（指示外の新規追加。登録だけして Event Log に乗らない「宣言はあるが効いていない」を作らないため）。⚠️ `docs/baseline.md` は両リポジトリと git 履歴のどこにも存在せず世代注記をそちらへ書けなかった——本記録が代替）

## BL-221

- Source: M4.4 の比較表の副産物 4（`docs/design-claude-executor.md` 課題I）/ 起票 2026-09-17・人間が承認
- Severity: Minor
- Trigger: **M4 完了後の最初のエンジン改修枠**（M4.4 の判定で codex.ts の凍結は解除された）
- Summary: **「executor 対称化の小枠」。同じ判定が 2 実装で既に分岐した箇所を claude.ts 側へ揃え、BL-219 / BL-220 を同じ枠で入れる。**
  M4.4 は「抽出しない」と判定した——共通ヘルパーへ寄せるのではなく、**意味の分岐だけを揃える**。個別:
  (1) cwd の内外判定: codex.ts は生の文字列で比べる（`isInside(paths.root, projectRoot)`）。claude.ts は 2026-09-04 のスモークで
  8.3 短縮名による誤判定を実測し `longPath` で正規化した。codex は未反映（今は冗長な `--add-dir` が付くだけで無害）
  (2) `numberSetting` / `stringSetting`: codex.ts は NaN / 0 / 負数 / 空文字を通す。claude.ts と engine は有限の正数・空白でない文字列だけ
  (3) codex.ts の自前タイマーと `CODEX_DEFAULT_TIMEOUT_MS`（30 分）: エンジン経由では必ず `req.timeoutMs` が埋まり watchdog が見張るので
  死んでいる（2026-09-02 の決定ログ「統合は M4.4 の後」）。claude.ts はタイマーを持たない
  (4) `req.signal` が execute の前に abort 済みのとき: claude.ts は即 kill、codex.ts は listener を足すだけで反応しない
  (5) 小さな重複ヘルパー（`firstLine` / `truncate` / `flatten` / `k` / `isInside`）は**抽出しない**
  （M4.4: 2 実装が独立に読めることの価値が上回る）
  ⚠️ codex.ts を変えたら clipboard 経路のテストを**同じコミットで**通し直す（不変条件5）。
  実装用のプロンプトが要るなら枠を開くときに用意する。
- Status: **done**（2026-09-17・BL-221 のコミット）。(1) `longPath` で正規化 (2) 設定値の検査を claude.ts / engine と同じ強さへ (3) 自前タイマーと `CODEX_DEFAULT_TIMEOUT_MS` を撤去——**撤去前に grep で確認**: 本番で codex executor を呼ぶのは `engine.ts` の `execStep` だけ（呼び元は `aiw exec` と drive）で、必ず watchdog の signal と `req.timeoutMs` が渡る。自前タイマーに依存していたのはテスト 96 だけで、signal 経由へ書き換えた (4) abort 済みの signal では起動しない（`meta.launched: false`）。中断の文言は claude.ts の「中断されました」へ揃えた。failureKind の語彙は不変 (5) ヘルパーは抽出していない。**実測**: テスト 173（abort 済み→起動しない）/ 174（実行中の外部 abort→kill・Event Log は transient で timeoutKind なし）/ 175（この環境の一時ディレクトリ `TOMO~1.SAK` で短縮名を実際に再現）/ 176（上限 0・空白の codexHome）。修正前の codex.ts では 173・175・176 が fail、174 は pass（実行中の中断は元から効いていた）。全 217 green・clipboard 経路（105 / 117 ほか）も同じ実行で green

## BL-220

- Source: M4.4 の比較表の副産物 3 / 起票 2026-09-17・人間が承認
- Severity: Minor
- Trigger: **次に codex.ts を触る枠**（BL-221 の小枠）
- Summary: **codex.ts は子プロセスの env を全部引き継ぐ（`{ ...process.env, CODEX_HOME }`）。** claude.ts は許可リスト方式
  （`CLAUDE_ENV_ALLOWLIST`。拒否リストでは知らない変数名を塞げない）。claude 側で実在を確認した漏れ変数
  （`ANTHROPIC_BASE_URL` / `CLAUDECODE` / `CLAUDE_EFFORT`——aiw が Claude Code の配下で動く限り必ず起きる経路）が
  codex の挙動に影響するかは未知。ただし **`OPENAI_*` 系（API キー・ベース URL など）が親の環境にあれば
  隔離 CODEX_HOME の外から設定が混入しうる、という同型のリスクは構造的に同じ**。
  手順: codex が env から読む変数を `--help` / 実測で確認 → claude の許可リストを出発点に codex 固有分を足す。
  ⚠️ PATH 系を落とすと起動できない（claude 側の実測）。許可リストは「起動できる最小」を実測で決める。
- Status: **done**（2026-09-17・BL-220 のコミット）。`CODEX_ENV_ALLOWLIST` + `codexEnv`。**実測**: codex 0.147.0 の実体が読む資格情報・接続先の変数をバイナリから抽出（`OPENAI_API_KEY` / `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` / `CODEX_AUTHAPI_BASE_URL` / `CODEX_URL` 等）。親に偽の `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_BASE_URL` を置いて codex exec を実際に 3 回起動: 全継承 → `CODEX_API_KEY` が隔離 CODEX_HOME の ChatGPT ログインを上書きして **401**（リスクは実在した）/ 許可リスト → 認証成功・成果物あり・漏れ 0 / PATH + SystemRoot のみ → 認証成功・成果物あり（起動できる最小）。最小まで削らない判断と理由は design-codex-executor.md の決定ログ。テスト 177

## BL-219

- Source: M4.4 の比較表の副産物 2 / 起票 2026-09-17・人間が承認（KI-09 系譜 #15）
- Severity: Minor
- Trigger: **次に codex.ts を触る枠（BL-221 の小枠）、またはローダーの検証を次に触るとき**
- Summary: **`steps.<id>.model` / `effort` / `bashAllow` は claude executor だけが読む。codex（や clipboard）のステップに書いても
  ローダーは弾かず、黙って無視される**（「宣言はあるが効いていない」の 15 例目）。`effort` は値の語彙だけを検証し、
  その executor が effort を読むかは見ない。根は BL-113 の schema 検証（`additionalProperties` を撤去した緩い版）と同じ
  「知らない・効かないキーを弾かない」。
  対策の方向: **ステップ設定のキーを executor 別に検証する**——executor ごとに「読むキー」の表を 1 箇所に持ち、
  読まないキーが書かれていればロード時に知らせる（落とすか、`config.deprecations` と同じ経路で表示するかは枠で決める）。
  ⚠️ codex に `steps.<id>.model` を読ませる方向（`codexModel` のステップ上書き）は別の判断。先に「効かない宣言を書けない」を入れる。
- Status: **done**（2026-09-17・BL-219 のコミット）。**先に数えた件数**: runtime / assets の workflow.yaml とも、その executor が読まないキーは **0 件**（runtime の effort / bashAllow は全て claude のステップ上）。指示の決め方では 0 件ならロード時エラーだったが、**表示にした**（設計からの逸脱）: 不変条件5「executor を clipboard に戻せば復帰」と衝突するため——runtime の review / research / improve-check は effort / bashAllow を持ち、executor の 1 行だけ戻すとロードが落ちる。実装: `EXECUTOR_STEP_KEYS`（types.ts・claude: model / effort / bashAllow）→ `findIneffectiveStepKeys`（loader）→ `config.ineffectiveStepKeys` → CLI が deprecations と同じ入口で「⚠ ineffective:」を表示。テスト 178（表と executor の実装のずれを source から照合）/ 179（codex ステップの model / effort）/ 180（claude ステップを 1 行で clipboard へ戻してもロードでき、そこで初めて列挙される）。KI-09 #15 を修正済みへ

## BL-210

- Source: M4 段階1-3 の境界後の集計（`versions.workflow` 6・2026-09-15〜16）/ 起票 2026-09-17・人間が承認
- Severity: Minor (deferred)
- Trigger: **`token-range` の halt が別の FEAT で再発したとき、または次に validator のメッセージを触る枠**
- Summary: **`token-range` 超過時の修正ループが高くつく。対処は「書く側に測らせる」ではなく「halt が削る目安を教える」。**
  ⚠️ **書く側は測らない。** research に aiw と同じトークン見積もりを持たせると、見積もりロジックの複製になり
  ドリフトの種になる（同じ規則を 2 箇所に持たない）。超えたら halt が教える、を維持する。
  実測（FEAT-api-layer-and-backend-move・2 タスク）: `context-package.md` が **~2029**（09-16 08:32・前のタスク）、
  **~1506**（10:39）、**~1790**（10:51）で上限 1500 を超えて halt。clipboard 時代の research 19 本では上限超えは 0 件
  （下限割れ 1 件・07-22）。research は自分で測ろうとして `node -e` / `wc -m` / `awk` を試み、拒否されていた
  ——これは症状であって、対処の方向ではない。
  ⚠️ **3 回とも claude の再実行なしで解消している**（halt → resume が 1〜11 分・間に exec なし＝validator を通すために
  誰かが手で削った）。1506 → 1790 の間には `ux-decision-required` の差し戻しがあり、判断を反映した再実行で増えた。
  **「モデルが手応えなしに削っている」証拠ではない**（2029 は別タスク）。コストの実体は「halt のたびに
  人間が見積もりの手応えなしに手で削る」こと。
  対処候補: `token-range` の violation メッセージに**現在値・上限・`##` セクション別の見積もり（どこを削れば収まるかの目安）**を
  含め、直す側（人間でも再実行でも）が 1 回で収束できるようにする。見積もりは validator 自身の関数を使うので複製にならない。
  ⚠️ validator の**緩和ではない**（上限は不変・不変条件4）が、M4 の前提「validator を変更しない」に触れるので M4 完了後の枠で。
- Status: open

## BL-209

- Source: M4 段階1-3 の境界後の集計（`versions.workflow` 6・claude 23 実行）/ 起票 2026-09-17・人間が承認
- Severity: Minor
- Trigger: **次に deny / allow（各ステップの `bashAllow`）を触る枠、または research / review の Skill・プロンプトを次に変更するとき**
- Summary: **`cd` で cwd を動かしてから `git` を呼ぶ複合コマンドは、許可リスト内でも必ず拒否される。**
  Bash の cwd は呼び出しをまたいで持ち越される。その履歴を追って分けると、`cd … && git …`（他のコマンドも全て許可内）は
  **cwd が変わる場合 36 件中 36 件拒否 / 変わらない場合 18 件中 1 件拒否**。git を含まない `cd` にこの偏りは無い
  （cwd が変わる場合でも 141 件通過）。**同じ文面が通ったり拒否されたりする原因はこの状態変数**で、フレークではない。
  仕組みは Claude Code 組み込みの保護（別ディレクトリで git を走らせることへの制限）と**推定**——拒否の文言は
  dontAsk の汎用文で理由を含まないため、**確かなのは 36:0 の実測だけ**。許可ルールでは直せない可能性が高い。
  対処候補（A を先に実測し、成立すれば A）:
  **A. 代替手段を与える: `git -C <path> <subcommand>` を許可する。** cd で移らずに別ディレクトリを見る手段になり、
  プロンプトの禁止事項ではなく**代替手段の提供**で解ける。以前の review の `git -C` 拒否 24 件（09-11 集計）は
  **許可リストに無かったから**で、保護の証拠ではない。要実測: (1) `git -C` 自体が同じ組み込み保護に掛からないか
  （「別ディレクトリで git」という点では同型なので掛かる可能性がある）(2) 許可ルールの形——`git -C:*` は `commit` 等も通すので、
  途中ワイルドカード（`git -C * status*` など）でサブコマンドを列挙する。途中ワイルドカードは deny では実測済み・allow では未実測
  (3) `--output` 系は `CLAUDE_BASH_DENY` の `*--output*` が `-C` 付きでも効くこと。
  **B. プロンプトで「git は cd と組み合わせない（cwd を動かしたら git は単独の呼び出しにする）」と書く。** A が成立しないときの第一手。
  入れたら runtime の `versions.workflow` を上げ、baseline に世代注記（拒否件数が下がるため）。
- Status: open

## BL-218

- Note: 旧 BL-121（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 段階1-3 research 初回実行の観測 / 2026-09-14（起票 2026-09-15・人間の判断）
- Severity: Minor (deferred)
- Trigger: **鮮度表示が「依頼より古い」を実際に出したタスクが 1 件出たとき、または次に postActions を触る枠**
- Summary: **research 成果物 2 本（`context-package.md` / `codex-prompt.md`）は archive も削除もされず、次タスクが上書きする運用。** research が書き損じた場合、前タスクの内容がそのまま `artifact-contract` を通る（見出しの存在しか見ない。`codex-prompt.md` には `token-range` も無い）。書き損じ時の防御は**承認ゲート②の鮮度表示（依頼より古い）だけ**。対処候補: research 成果物も `task-metadata.json` / `ac-*` と同じ「**archive 後に削除**」へ寄せる——0 バイトスタブの機構が毎タスク働くようになり、鮮度問題も構造ごと消える。KI-09 系譜 #10（生成だけ配線して掃除を忘れる）の変種として、忘れる前に台帳へ積む。⚠️ 2026-09-14 の初回では**実際には起きていない**（3 本とも実行中に書かれたことを mtime と内容で確認）。
- Status: open

## BL-217

- Note: 旧 BL-120（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 段階1-3 の切り替え（research の bashAllow 設計）/ 2026-09-14
- Severity: Minor (deferred)
- Trigger: **次に deny / allow（`CLAUDE_BASH_DENY` か各ステップの `bashAllow`）を触る枠**
- Summary: **仕様根拠で許可した Bash コマンドを実測し、暫定マークを外す。** 2026-09-14 時点で
  「ファイルへ書く引数を持たない」という仕様上の性質だけを根拠に許可しているもの:
  `head` / `tail` / `ls` / `wc` / `git ls-files` / `git check-ignore`（research）、
  `git status` / `git show`（review・improve-check、09-04 から）、`git rev-parse`（research、09-15 から）。
  **`--output` の穴自体が「仕様の思い込みが実測で裏切られた」直後**なので、「検証済み」と
  「仕様上安全なはず」の区別を記録に残し、次の枠でまとめて潰す。
  ~~`dotnet build -o <path>`~~ → **2026-09-14 に実測して消し込み**（通ってビルド産物を書けた →
  `Bash(dotnet* -o*)` を追加）。同時に `-p:OutDir=` も書けたが、ビルド産物に限られ綴りの揺れで
  網羅できないため**残余として受け入れた**（設計文書 §9-2b・決定ログ）。
  追加（2026-09-14・許可リストの目視）: `./tools/nrun.cmd build -- --outDir <dir>`（vite）/
  `./tools/nrun.cmd test -- --coverage.reportsDirectory=<dir>`（vitest）。書けるのはビルド産物 /
  カバレッジレポートで等級は低く、本番の使用は 0 件。`--` 以降の引数経路は正当に使われている
  （本番 31 回）ので、塞ぐなら nrun.cmd 限定で列挙する。
  方法: 1 コマンド 30 秒のプローブ（許可プレフィックスの下で書き込み形を試す + 対照 `cp`）。
  手順と結果の表は `docs/design-claude-executor.md` §9-2b。
- Status: open

## BL-216

- Note: 旧 BL-119（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: 2026-09-11 の拒否分類（134 件）/ 2026-09-14 に人間が承認
- Severity: Minor
- Trigger: **次のタスク境界**（research の claude executor 初回実行の完了後）
- Summary: **review / improve-check の `bashAllow` へ `cd:*` を足す。** 拒否の 60%（81 件）が
  `cd` による形式だけの拒否で、毎タスク数往復の無駄になっている。安全性は実測済み
  （`cd` 自体は書かない。`cd … && … > f` のリダイレクトは Edit ルールで判定される・2026-09-14。
  引数経由の書き込みは `CLAUDE_BASH_DENY` が常時塞ぐ）。
  挙動の変更ではなく無駄往復の除去なので観測を汚す種類ではないが、**世代管理の規律として境界で入れる**:
  runtime の `versions.workflow` を上げ、`docs/baseline.md` に世代注記（期待される効果:
  review の `permission_denials` の `cd` 起因が 0 に近づく）。
- 同じ境界で入れる（2026-09-15 承認）: research の `timeoutMs` 60 → 40 分（yaml に「暫定・実測 3 本で再確認」。下に idle 15 分がいるので締めすぎのリスクは小さい）/ research の `bashAllow` に `git rev-parse:*`（仕様根拠・未実測なので BL-217〔旧 BL-120〕の暫定マーク付き）。versions bump と世代注記は 3 件で 1 回にまとめる
- Status: **done**（2026-09-15。review / improve-check に `cd:*`、research の上限 40 分、research の `git rev-parse:*` を同じ境界で投入。runtime の `versions.workflow` 5 → 6、世代注記は baseline）

## BL-215

- Note: 旧 BL-118（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 段階1-3 の前提整備（知識の届け方）/ 2026-09-11
- Severity: Minor
- Trigger: **2 回目の knowledge 監査時、または索引起因の読み漏れが 1 件出たとき**
- Summary: **`context.md` の `## 索引` と本文 `##` 見出しのドリフトを機械検査する。** 索引の維持を reflection Skill の宣言に委ねた形は、系譜の言葉で言えば「**宣言だけ**」の状態で、節を足して索引に行を足さなければ**次のタスクからその知識は届かない**（読み手は索引しか見ない）。一致は grep で機械照合できる（`## 索引` の表の1列目 vs `^## ` の見出し集合）。⚠️ **validator は増やさない**（M4 の前提「validator を変更しない」）。Test 58 方式——「壊れていないこと」をテストが直接見る形——で `tools/aiw` 側のテストに置く。同じ検査は `instructions/local-environment.md` の `## 目次` と `local-environment-detail.md` の見出しにも要る（分割した以上、同型のドリフトが起きる）。
- Status: open
## BL-214

- Note: 旧 BL-117（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 段階1-1 の実装中に判明（claude executor の JSONL 回収）/ 2026-09-04
- Severity: Minor
- Trigger: `aiw log` を次に触るとき、または claude 実行の詳細を後から追う必要が出たとき
- Summary: **`aiw log` が読めるのは `runs/codex/` だけ**で、claude executor が tee する `runs/claude/` の JSONL は整形できない。`codexLog.ts` の整形は codex のイベント語彙（`item.*` / `thread.started` / `turn.completed`）専用で、claude の語彙（`system:init` / `assistant` / `result`）とは別物のため。段階1-1 では「記録が無い」と言って終わらせないための最小対応として、claude の実行があればそのファイルパスを案内するようにした（`cli.ts`）。本対応は claude 側の整形（`summarize` と同じ対応表を読み取り側にも持つ）だが、**M4.4 の「イベント語彙を共通化するか」の判定と同じ論点**なので、判定の前に片側だけ実装しない。
- Note (2026-09-25 TASK-2026-09-25-aiw-log-claude): 前提の M4.4 は「語彙は provider 固有のまま・共通化しない」で決着済みだったので、
  claude 専用の整形 `src/engine/claudeLog.ts` と、codex / claude から新しい方を選ぶ `src/engine/runLog.ts` を足した（`codexLog.ts` は不変）。
  整形表示と `--json` は生の session ID を出さない（Test 221-229）。**M5 の `aiw auto` で区間を無人実行した最初のタスク**。
  review の Backlog（`npm test` 一式が executor のコマンド上限を超える）は BL-241 へ。
- Status: resolved (TASK-2026-09-25-aiw-log-claude)

## BL-213

- Note: 旧 BL-116（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 設計セッション（Edit-only の検討中に実測で発見）/ 2026-08-31
- Severity: Major (deferred)
- Trigger: research の validator を次に変更するとき、または「書かれていない成果物が通った」事象が観測されたとき
- Summary: **`templates/research-findings.md` は契約の必須8見出しを全て含むため、research が一度も書かなくても `file-exists` と `artifact-contract` を通過する**。`artifact-contract` は `checkMarkdownSections` で見出しの存在しか見ず、`research-findings.md` には `token-range` が掛かっていない（掛かっているのは `context-package.md` のみ）。KI-09 系譜「生成だけ配線して素通りを塞ぎ忘れる」/ `task-metadata.json` で踏んだ罠と同型で、**M4 が持ち込んだものではなく既存**。`aiw status --summary` の Open Decisions 件数など、この成果物を読む下流も同時に静かに壊れる。対処案: (a) `research-findings.md` にも `token-range` の下限を掛ける (b) 契約を「見出しの存在」から「見出し配下に本文があること」へ拡張する（validator 変更）。**実績の確認方法**: Event Log で `research-findings` の artifact-contract が passed でありながら中身がテンプレートと同一だったタスクを数える。
- Status: open

## BL-212

- Note: 旧 BL-115（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: M4 設計セッション（design-claude-executor.md 課題B）/ 2026-08-31
- Severity: Minor
- Trigger: M4 実装が安定した後の validator 改修枠
- Summary: review 用に diff-scope の「宣言ゼロ」モードを追加し、第2網を本物にする。`declaredFilesFrom` の既定が `context-package.md` のため、review が Modify 集合内のファイルを触っても第2網（diff-scope report）が反応しない。validator 変更にあたるため M4 では見送り（M4 前提3）。それまでは第1網（ツール制限）がこの穴を塞ぐ唯一の防壁。
- Status: open

## BL-211

- Note: 旧 BL-114（2026-09-17 に振り直し。アプリ側と衝突していた）
- Source: BL-113 の実装中に判明（2026-08-31 のエンジン改修枠）
- Severity: Minor
- Trigger: `aiw init` を新環境へ配るとき、または assets↔runtime の宣言差分を次に棚卸しするとき
- Summary: M3 で runtime に配線した `consumer-presence` / `measurement-completeness` validator の宣言が `assets/config/workflow.yaml` に無く、`aiw init` で配られない（grep 0 件）。ac-* の `optionalOutputs` と `artifacts` 定義は BL-113 で assets へ移植済みなので、残る差分はこの validator 2 宣言（`executor: codex` のような環境依存の意図的差分は除く）。意図的な差分と移植漏れを仕分けし、移植するものは test 88 系のテストで固定する。
- Status: **done**（2026-09-04。M4 のついで枠。implementation へ consumer-presence + measurement-completeness、fix へ measurement-completeness を `onViolation: report` で移植。**非対称は意図**（consumer の実在は実装の話で fix で増えない / fix は ac-result を作り直す）なので Test 143 で「fix に consumer-presence を置かない」ことまで固定した。仕分けの結果、移植しなかった runtime 固有の宣言は `executor` / `codexHome` / `codexModel` / `verifyLocal` / `knownFailurePatternsFile` / タイムアウト値 / `steps.improve-check.executor` = **いずれも環境依存**）

## BL-190

- Source: アプリ側 `.ai-workflow/backlog.md` の BL-114（TASK-cell-dropdowns / current-review.md `## Backlog`）から移動（2026-09-14 棚卸し）
- Severity: Minor
- Trigger: ⚠️ **次にフェーズを跨ぐとき、または前タスクの差分を未コミットのまま次タスクへ進むとき**
  （`scope-violation-report.md` に身に覚えのないファイルが並んだらまずこれを疑う）
- Summary: ⚠️⚠️ **diff-scope の baseline がフェーズを跨いでも更新されない。**
  **baseline `2026-08-31T08:38:12Z`（17:38 JST）が Phase 1 の実装（17:43 / 17:44）より古く、
  Phase 1 の未コミット差分 2 件（`useGridSelection.tsx` / `EditableGridCore.tsx`）が
  Phase 2 の未宣言変更として報告された。**
  ⚠️ **実装は触っておらず（`find -newermt` で今回の変更は宣言どおり 9 件ちょうど）純粋な偽陽性。**
  **人間がコミットしない運用ではフェーズを重ねるほど偽陽性が増える。**
  `CLAUDE.md` の設計上 `recaptureBaseline` は対話 CLI（`aiw baseline capture`）からのみ
  呼べるので、**フェーズ完了時に人間が取り直すか postActions で取り直すかを決める必要がある**
  （後者は「resume で取り直すと検査が無言で無効化される」既存の禁止事項と衝突しないか要検討）。
- Note: ⚠️ **本ファイルの `BL-211`（旧 BL-114・assets↔runtime の宣言差分・done）とは別件。** アプリ側と番号が衝突するため新しい番号を振った。
- Status: open

## BL-238

- Source: M5 設計（`docs/design-auto.md` 課題D2）/ 起票 2026-09-25・人間が承認
- Severity: Minor
- Trigger: **M5 の実装と並行してよい**（D2 のモデルフォールバックの前提。BL-221 と同種の executor 整備）
- Summary: **executor の返り値に `transientCause`（`capacity` / `rate-limit` / `network` / `unknown`）を足す。**
  今の `failureKind` は transient / permanent の二値で、容量不足（2026-09-18 の codex 2件
  `Selected model is at capacity. Please try a different model.`）もネットワークエラーも理由不明の失敗も
  同じ transient になる。D2 の発動条件「容量不足・rate limit のときだけ」を判定する欄が無い。
  分類は**生のイベントを見た場所**（claude: `api_error_status` 429 / 529 と本文、codex: エラー本文）に置く。
  auto やエンジンが `result.error` の文字列を正規表現で分類する案は採らない（分類が3箇所目になり、KI-01 型のずれの温床）。
  ⚠️ `failureKind` の意味は変えない（transient / permanent の判定はそのまま。`transientCause` は transient の内訳）。
  ⚠️ codex.ts を変えたら clipboard 経路のテストを**同じコミットで**通し直す（不変条件5）。
- Status: open

## BL-239

- Source: M5 設計（`docs/design-auto.md` 課題I）/ 起票 2026-09-25・人間が承認
- Severity: Minor
- Trigger: **BL-213 が解消済み**、かつ M5 の運用で auto の区間に invalid-status が再び出たとき
  （または research の語彙の書き損じ〔2026-09-11 の `researched` 型〕が再発したとき）
- Summary: **status 宣言の機械導出。** 単一結果のステップ（implementation / fix / task-planning / review-audit）の result と、
  research の既定値（research-complete）をエンジンが導出し、AI の宣言は判断を含む自己申告
  （ux-decision-required、review / improve-check / reflection の判断）だけにする。
  ⚠️ review の ready / fix-required と improve-check の二値は**判断であり導出しない**（契約の意味の解釈をエンジンへ移すことになる）。
  **設計条件: `status.step` が担っていた「この宣言は今のステップのために書かれた」という鮮度の証明を失わないこと。**
  2026-09-04 の事故（前タスクの status が一致検査を素通りし、古い計画が承認ゲートまで進んだ）が実例。
  儀式を消すなら、この役割の代わり（例: 遷移の確定時にエンジンが status ファイルを消す）を同じ変更の中で用意する。
  前提の BL-213 は、明示の完了申告を外すと research-findings の見出しだけのテンプレートが**完了扱いで素通り**するため。
  見積もりと実測の根拠は設計文書の課題I（区間の invalid-status は executor 化以降 0件）。
- Status: open

## BL-240

- Source: M5 設計（`docs/design-auto.md` 課題A の A3）/ 起票 2026-09-25・人間が承認
- Severity: Minor
- Trigger: auto を implementation / review / fix / improve-check の区間で運用し、停止挙動（A1〜A25 の発火と誤停止の有無）を実測できたとき
- Summary: **research に `auto: true` を付けるか（無人区間へ組み入れるか）を判断する。** M5 の初期は付けない（段階制）。
  research は `ux-decision-required` で自分に戻る唯一のステップで、無人で回すと「AI が UX 判断を保留したまま research を
  再走し続ける」経路が理論上ある。判断の材料: (1) 現行の設定では research はゲート②を持つので、`ux-decision-required` でも
  毎回承認待ちで止まり、周回ごとに人の承認が挟まる (2) ゲートを外した research に `auto: true` を付けると、
  auto の起動時の構造検査が「retryPolicy を通らない循環」として起動を拒否する（A24）。
  research の所要（実測 139 分の大半は人間の検討）と、対話の喪失（M4 課題C）も併せて見る。
- Status: open
