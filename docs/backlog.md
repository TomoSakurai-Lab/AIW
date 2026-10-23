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
- 追記（2026-10-05・M5 段階4 の観測）: **research を auto で再走させていた期間（09-25〜10-05）に長さ超過の halt が 9 件増えた。**
  09-26 02:07（~1738）/ 09-28 11:55（~1569）→ 12:02（~1569・削らずに resume）→ 12:07（~1542）→ 12:08（~1519）→ 12:08（~1505）/
  13:02（~1695）→ 13:05（~1643）→ 13:05（~1622）（時刻は日本時間）。
  **ux-decision の答えを追記する形の再走が、前の内容と重なって package を太らせる**（周を重ねて 1,500 を超える）。
  そのあと人が resume のたびに少しずつ削って収束させており、上の「halt のたびに人間が手応えなしに手で削る」の実例が増えた。
  ⚠️ BL-240 の再組み入れ条件②（research を無人区間へ戻す前に、この問題を対処する）。
- 対処（2026-10-06・判断インフレ対策の枠）:
  1. **違反メッセージ**: `token-range` の違反に「上限を N 超過（下限に N 不足）」と**トップレベル `# ` セクション別の見積もり（大きい順）**を足した
     （`tokens.ts` の `estimateTokensBySection`。見積もりは validator 自身の `estimateTokens` をそのまま使う＝複製しない）。
     先頭の `~N tokens outside [min, max]` は以前の形のまま。上限・下限は変えていない。Test 233
  2. **research Skill v7**: ux-decision の回答を受けた再実行では context-package を**追記ではなく再構成**する（太る原因そのものへの手順）
  効果の観測は次の ux-decision の再走で行う（BL-240 の条件②は「対処済み・効果は未観測」）
- ⚠️ 発見（2026-10-06）: **runtime の token-range の上限が 2026-09-28 13:06（日本時間）に 1,500 → 3,000 へ引き上げられていた。**
  Event Log で、13:05 に ~1622 で halt した 31 秒後の 13:06 に ~1606 が `in [250, 3000]` で通っている。versions は上がっておらず、assets は 1,500 のまま。
  CLAUDE.md の不変条件4（上限は Codex の焦点を守るための制約で緩和しない）に関わるので、**戻すかどうかは人間が決める**（この枠では変えていない）
- 決着（2026-10-06 18:1x・人間の判断）: **runtime の上限を 1,500 へ戻した**（`versions.workflow` 10 → 11。assets と揃った）。
  `aiw tokens`（BL-281）で research が一度で収められるようになったので、戻しても削り直しの往復は増えにくい、という判断。
  反映の時点で、進行中のタスクの research は承認済み（implementation の実行中）。そのタスクの context-package は ~2930 で新しい上限を超えるが、
  research を再実行・再検証しない限り影響しない
- Status: resolved (2026-10-06・メッセージと再構成の規則、上限は 1,500 へ戻した)

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
- 追記（2026-10-05・M5 段階4 の観測）: **同じ枠で BL-272（claude が認証切れを transient に分類する）も直す**（人間の判断）。
  あわせて、容量不足が実運用で再発した: 10-05 の implementation（codex）で `Selected model is at capacity` が 5 回、約 50 分続いた。
  auto は設計どおり 5 分待って再試行したが、人が待機を 4 回打ち切り、最後は executor を通さずに成果物を作って `aiw run` した
  （Event Log に exec の記録が無い）。**D2（モデルフォールバック）があれば無人のまま越えられた事象の実例**。
- Priority（2026-10-05 人間の決定）: **この実例で優先度を上げた。** 枠の中身は `transientCause` + BL-272 + D2。
  順序はテスト実行の信頼性（BL-241）→ 判断インフレ対策（未起票）→ **この枠**
- 段階1（2026-10-15）: `ExecutorResult.transientCause`（`capacity` / `rate-limit` / `network` / `unknown`）。付くのは failureKind が transient のときだけで、
  中断には付けない（timeoutKind が持つ）。分類は生のイベントを見た executor の中: claude は `classifyTransientCause`（529 / overloaded → capacity・
  429 → rate-limit・接続系 → network・529 以外の 5xx は unknown）、codex は `classifyCodexFailure`（実物 14 件の `Selected model is at capacity` → capacity）。
  codex の 400 `invalid_request_error`（2026-10-07 に古い CLI で新しいモデルを呼んだときの実物）は再試行しても同じなので permanent にした。
  エンジンは `exec.failed` に `transientCause` を記録する。`failureKind` の意味と auto の再試行は不変。Test 243。BL-272 も同じ段階で対処
- 段階2（2026-10-15）: D2 のモデルフォールバック（`docs/design-auto.md` 課題D2 の仕様表どおり・決定ログに実装時の判断2つ）。
  `settings.codexModelFallbacks` / `claudeModelFallbacks`、記録は `auto.fallback`。Test 244（モデルの差し替えを外すと落ちることを確認）。
  既定は空。どのモデルへ逃がすかは比較可能性に関わるので人間が決める。
- runtime の値（2026-10-15 人間の決定）: `codexModelFallbacks: [gpt-6-sol]`（workflow v13）。候補 3 つ（gpt-6-sol / gpt-5.6-sol / gpt-6-astra）が
  pin した codex 0.160.1 + 隔離 CODEX_HOME で応答することを最小の呼び出しで確認済み。claude 側は空のまま
- 観測（2026-10-19）: 10-15〜10-19 の 6 タスクで発動 0 回（容量不足 / rate limit の失敗が無かった）。**観測継続**（人間）
- Status: resolved (2026-10-15)

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
- 追記（2026-10-20・BL-291）: reflection の `nextPhaseId` の書き漏れは、claude executor にしても消えなかった（10-20 03:47）。手貼りの頃から reflection の halt 11 件中 9 件。
  feature.md の Current phase と Phase list から**機械的に導ける値**なので、根治はこの BL（status の機械導出）。ただし `aiw run` の挙動を変える（不変条件1）ので設計と承認が要る。
  当面は Skill の1行と、halt の文言に正解の候補を出す表示で手当てした（BL-291）

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
- 決着（2026-10-05 人間の裁定）: **research を無人区間から外す**（runtime の `auto: true` を削除、`versions.workflow` 9 → 10）。
  ⚠️ runtime では 09-25 17:21 から research にも `auto: true` が付いていた（version を上げず、設計の保留を先取りした状態）。実測
  （09-25〜10-05・auto で回した 11 タスク。最初の1本〔BL-214〕の research 1 回は付く前で、区間外として手動実行）:
  - research の実行 **44 回**（1 タスク平均 4.0 回・最大 10 回）、`ux-decision-required` の戻り **14 回**
  - `context-package.md` の長さ超過による halt **9 回**（再走のたびに膨らんだ。BL-210 に追記）
  - **起動直後の人の Ctrl+C 8 回**（2〜274 秒。auto が承認の直後に research を再起動し、人が手で止めた。理由は記録に無い）。
    ほかに認証切れの再試行の待機を打ち切った Ctrl+C が 2 回（BL-272）
  - 総上限 40 分の打ち切り 2 回・無進行の打ち切り 1 回、status を書かずに終わった（A17）2 回
  これは設計（裁定 #1）が「判断を保留したまま再走し続ける」として保留にした経路そのもので、**人が機械と逆向きに戦った**。
- 再組み入れ条件（2つとも入ってから、もう一度 n=5 で観測する）:
  1. **承認の前に、Open Decisions へ決定が書かれたことを検査する仕組み**（例: ゲート②の時点の research-findings.md の `# Open Decisions` の
     ハッシュを控え、`ux-decision-required` の後の再走の前に変化を確かめる）。⚠️ 2026-10-05 時点で設計も番号も無い（未設計）
  2. **再走のたびに context-package.md が膨らむ問題（BL-210）の対処** → 2026-10-06 に対処（違反メッセージの内訳 + 再構成の規則）。**効果は未観測**
- Status: resolved (2026-10-05・research を区間から外した。再組み入れは上の条件付き)
- **再組み入れ（2026-10-14 人間の指示）**: runtime の research に `auto: true` を戻した（`versions.workflow` 11 → 12）。
  条件②は対処済み（10-06〜10-08 の 7 タスクで長さ超過の halt 0 回・BL-283 で削り直しも対処）。判断インフレ対策で `ux-decision-required` は
  0.14 回/タスクまで減った。⚠️ **条件①（承認の前に決定が書かれたことの検査）は未実装のまま**戻している——`ux-decision-required` の承認の直後に、
  決定を書く前の research を auto が再起動しうる経路は残る（起きたら人が Ctrl+C で止め、決定を書いてから再開する）。
  起動時の構造検査は通る（循環なし・予算 9 = research 1 + implementation 1 + review 1 + fix 3 + improve-check 3）。
  **観測（n=5）**: research の実行回数/タスク・`ux-decision-required` の承認直後の自動再起動と人の Ctrl+C の回数・長さ超過の halt。
  Ctrl+C が 10-05 以前のように出るなら条件①を設計する
- 観測の結果（2026-10-19）: 戻した後の 12 タスク（10-14〜10-19）で ux-decision-required の停止 0 回・長さ超過の halt 0 回・Ctrl+C 2 回（どちらも起動の直後で、
  決定前の自動再起動を止めた形ではない）。**効果確定・closed**（人間）。条件①の経路は一度も試されていない（ux の停止が起きていない）ので、起きたら観測する

## BL-241

- Source: TASK-2026-09-25-aiw-log-claude / current-review.md `## Backlog`（review M1）。runtime の `backlog.md` にも reflection が同じ項目を転記している
- Severity: Major
- Priority: **次の枠で対処**（2026-09-25 人間の判断で deferred から引き上げ）。放置すると aiw 側の全タスクで再発する——
  implementation / fix がテストを流すたびに上限に当たり、AC の証拠がゼロになる
- Trigger: **次の枠**（aiw 側のタスクを次に流す前）
- 枠の名前: **「テスト実行の信頼性」**。**BL-243（全件 pass でも exit 1）を統合した**（2026-09-25 人間の判断）。どちらも「テストの結果を機械が正しく読めない」問題
- Summary: **`npm test` 一式が executor のコマンド上限（~120 秒）を超える。** 2026-09-24 に 228 本・110.5 秒（上限の 92%）、
  2026-09-25 に M5 の auto テスト 26 本（実物の CLI の spawn と実物の watchdog を含む）と BL-214 の 9 本で 270 本・約 180 秒。
  executor の中で最終検証に `npm test` を使うと出力を残さず exit 124 で殺され、AC の証拠が全件ゼロになる（BL-214 の implementation で実際に起きた）。
  対処は (a) スイート分割（`test/index.ts` を 2 つ以上へ。遅いもの〔CLI spawn / 実物の watchdog / git を使う fixture〕を分ける）/
  (b) executor 側のコマンド上限の引き上げ、のどちらか。当面は executor の中ではファイル単位で実行する（runtime `context.md`「ワークフロー構成」末尾）。
- 枠のスコープ（2026-09-25 人間の判断）:
  1. **方向を1つ選ぶ**: (a) テストの分割実行（ファイル単位）を implementation / fix の Skill の手順にする /
     (b) executor のコマンド上限の引き上げ / (c) テストの高速化（遅いもの〔CLI の spawn・実物の watchdog・git の fixture〕を減らす・分ける）
  2. **BL-243 の根治**（Test 174 がテスト終了後に書き込まないようにする）
  3. ⚠️ **暫定運用「合否は終了コードではなく `# fail 0` で判定する」を Skill に明記する。** 今は runtime `context.md` と `learnings.md` にしか無く、
     Skill に無いと次の implementation が exit 1 を FAIL と誤判定する（exit code を信用しない規律があっても、手順に書かれていなければ届かない）。
     2 で根治しても、上限に当たった exit 124 を「FAIL ではなく NOT VERIFIED」と書き分ける手順は残す
  - Skill を変えたら `versions` の更新と Test 88 を同じコミットで（不変条件7）
- 対処（2026-10-05・テスト実行の信頼性の枠）:
  - **計測で分かったこと: 遅いテストが一部に集中しているのではなかった。** 上位 10 件は一式の 16%（約 27 秒）で、全部外しても約 139 秒と上限を超える。
    本体は**ほぼ全テストが使う準備処理 `makeRoot`**: 1 回 446ms のうち git のプロセス 6 回が 352ms、約 250 回呼ばれていた
  - **実施 (c) テストの高速化**: `test/helpers.ts` の `makeRoot` が git の雛形（init + config + .gitignore + 初回コミット）を
    プロセスで 1 回だけ作り、各テストへは複製を渡す。テストが受け取る状態は同じ（独立したリポジトリ・初回コミット済み・ランタイムルートは gitignore）。
    **一式 166 秒 → 85 秒**（273 本）。テストの削除・弱体化はしていない
  - **実施 (a) Skill の手順**: implementation v5 / fix v6 に「検証の段階制とコマンドの上限」（開発中は関係するファイルを指定・一式は最後に 1 回・
    上限で打ち切られたら FAIL ではなく NOT VERIFIED で数値の理由・手段を変える）。aiw 固有の実行コマンドは Skill に書かず runtime の `context.md`
  - **BL-243 の根治**（下記）。スコープ 3 の「`# fail 0` で判定する」暫定運用は**Skill には一度も書かれていなかった**（runtime の context.md と
    learnings.md だけ）ので、Skill からの撤去は無く、context.md を「終了コードは信用してよい」へ書き換えた。exit 124 を NOT VERIFIED と書き分ける手順は Skill に残した
  - 実測: 一式 10 回連続で全件 pass・**終了コード 0**（84〜87 秒・uncaughtException 0）。BL-214 と同型の手順を上限 120 秒の下で流すと、
    関係するファイル単位 3.7 秒 / 2.4 秒（全件 pass）→ 最後の一式 85 秒（273 件 pass・exit 0）で、AC の証拠がすべて上限内に取れた
  - 遅いテスト上位 10 件（高速化の前 → 後）: 172 feature-archive 5.0→4.8s / watchdog の閾値未満の沈黙 3.4→3.1s / 198 auto 3.4→2.7s /
    27b task-metadata 2.7→2.4s / 183 diff-scope-injection 2.4→1.7s / 220 auto（実物の CLI）2.4→2.0s / 231 auto（drive の CLI）2.1→1.8s /
    211 auto 2.1s / 1 fix-loop 1.9→1.6s / 188 situation（drive の CLI）1.8→1.6s。ファイル別の最大は auto.test.ts（28.8→16.5s）
  - **提案止まり**: (1) 遅いテストの分離（slow suite）——上の計測のとおり今は効かないので入れない。CLI を spawn するテスト（auto / situation /
    claude-log の約 10 本・各 1.5〜2.5 秒）が増えて一式が再び 100 秒を超えたら最初の候補 (2) ランナーの並列化——各テストは独立の一時ディレクトリを使うが、
    `process.env` やカレントディレクトリに触れるテストの有無を洗う必要があり未調査 (3) 上限の引き上げ——不要（最後の手段のまま）
  - ⚠️ **再発の見張り**: 一式の所要が 100 秒（上限の 83%）を超えたら、この枠を開け直す
  - 追記（2026-10-06・人間の注文）: 分割実行が網（故障注入・防衛線）の検出を最後の一式まで遅らせる構造になったことを、
    implementation Skill v6 / fix Skill v7 に1行で明記した（「最後の一式1回を省略した完了報告は不完全」）。
    **improve-check の確認項目にするかは保留**: 数タスク見て、一式を省いた完了報告が実際に出るかを確かめてから判断する
  - ⚠️ 観測（2026-10-06）: 一式が **103 秒 / 99 秒**（2 回・273 本・全件 pass・exit 0）。前日の 10 回は 84〜87 秒。
    計測中に claude / codex のプロセスが 13 個動いていた（負荷による揺れと見ている・未切り分け）。**見張りの基準 100 秒の境目**にいる。
    負荷の無い状態で再計測して 100 秒を超えるなら、提案止まりの (1) slow suite の分離を開ける
  - 観測（2026-10-06 18:0x）: 一式が **137 秒**（277 本・全件 pass・exit 0）。implementation の codex と dotnet のビルド 3 本が並行して動いていた。
    負荷があると上限（約 120 秒）を超える。⚠️ aiw の改修と aiw の実運用（codex / claude の実行）を同じマシンで同時に行うと、
    aiw のテスト一式は上限内に収まらないことがある（executor の中で一式を流すのは aiw 側のタスクだけなので、実害はそのときに出る）
- Status: resolved (2026-10-05・テスト実行の信頼性の枠。BL-243 を含む)

## BL-242

- Source: M5 段階2 の実装（`docs/design-auto.md` の故障注入 #5 の確認）/ 2026-09-25
- Severity: Minor
- Trigger: 次に `src/engine/executors/claude.ts` を触る枠（BL-238 の `transientCause` と同じ executor 整備の枠が最有力）
- Summary: **claude executor は abort 済みの signal を渡されても子プロセスを起動し、起動した後で即 kill する。**
  codex は起動前に返す（BL-221 (4)・Test 173）が、claude 側は同じ対称化がされていなかった（`claude.ts` は `launch()` の後で `req.signal?.aborted` を見る）。
  設計の故障注入 #5「abort 済みの signal で起動 → executor が起動しない（codex / claude の両方）」は claude 側で満たされない。
  auto への実害は小さい: auto は exec の前に自分の signal を見るので（Test 208）、この経路に入るのは exec 直前の瞬間に Ctrl+C が来た場合だけで、
  起動した claude も即 SIGTERM される。**直すなら Test 173 と同じ形のテストを claude 側に足し、clipboard 経路のテストを同じコミットで通し直す**（不変条件5）。
- ⚠️ 取りこぼし（2026-10-15）: Trigger の「BL-238 の枠」で `claude.ts` を触ったのに、この項目を確認せずに枠を閉じた（Claude の見落とし）。同日の後追いで対処
- 対処（2026-10-15）: `claude.ts` の execute の冒頭（実行体の確認より前）で abort 済みなら起動せずに返す（codex と同じ文言・`meta.launched: false`）。
  Test 245（Test 173 と同じ形）。チェックを外すと 245 が落ちることを確認（変異）。全件を同じコミットで通し直した
- Status: resolved (2026-10-15)

## BL-243

- Source: M5 段階2 の検証（`npm test` の終了コードを単体で確認）/ 2026-09-25
- Severity: Minor
- Trigger: 次に `test/codex-executor.test.ts` を触るとき、または `npm test` の終了コードで合否を判定する仕組み（CI・`&&` の連結）を入れるとき
- Summary: **`npm test` は全件 pass でも終了コード 1 を返すことがある。** Test 174（外部 abort で codex を kill する）が、テスト終了後に
  閉じたストリームへ書き込み（`ERR_STREAM_WRITE_AFTER_END`）、node:test が uncaughtException として扱うため。
  実測（2026-09-25）: `test/codex-executor.test.ts` の単体実行は **6 回中 6 回 exit 1**、`npm test` 一式は **2 回中 1 回 exit 1**（タイミング依存）。
  `b562360`（M5 段階1 の最終コミット）の worktree でも単体実行で exit 1 で、M5 より前から既存。
  これまでの検証はパイプ越しに `# pass` / `# fail` を読んでいたので表に出ていなかった（CLAUDE.md の「パイプの終了コード」の罠と同型）。
  当面は `# fail 0` で判定する。直すなら Test 174 の fake の stdout を、kill の後に書かないようにする。
- 根治（2026-10-05）: **原因は Test 174 の偽 codex（`fakeCodex`）が本物の子プロセスと違う順序でイベントを出していたこと。**
  本物の ChildProcess は stdout が閉じた後にしか `close` を出さないが、偽物は kill で即座に `close` を呼び、その後で 1ms タイマーが出力を書いていた。
  起動前の同期処理（git rev-parse など）が 30ms を超えると中断のタイマーが先に期限を迎え、executor が閉じた JSONL の記録先へ書き込んで
  `write after end` → uncaughtException になっていた（単体で毎回・一式でタイミング次第、の実測と一致）。**本番の executor では起きない**。
  偽 codex と、同じ形の偽 claude（`fakeClaude`）を「kill されたら以後書かない・stdout を閉じてから close」に直した。executor は変えていない。
  実測: `codex-executor.test.ts` の単体実行 修正前 6/6 で exit 1 → 修正後 3/3 で exit 0、一式 10 回連続で exit 0
- Status: resolved (2026-10-05・BL-241 の枠で根治)

## BL-272

- Source: M5 段階4 の観測（Event Log 2026-09-30）/ 起票 2026-10-05・人間が承認
- Severity: Major
- Trigger: **BL-238（`transientCause`）の枠が立つとき、同じ枠で直す**（人間の判断）
- Summary: **claude executor が認証切れ（`Failed to authenticate: OAuth session expired and could not be refreshed`）を transient に分類する。**
  auto はこれを再試行対象として 5 分 / 15 分 待ち、待っても直らないので**人が Ctrl+C するまで待ち続けた**
  （2026-09-30 の research で 4 回失敗・`auto.retry` 4 件・待機の打ち切り 2 回）。無人運転の約束の否定にあたる。
  原因は `claude.ts` の `classifyFailure`: permanent にするのは `api_error_status` 401 / 403 と、本文の
  `not logged in|authentication_failed|unauthorized|invalid api key|refus` だけで、`OAuth session expired` はどれにも当たらず、
  最後の「分からないものは transient に倒す」に落ちる。codex 側（`codex.ts`）は `401|unauthorized|not authenticated|invalid api key` を
  permanent にしている。**`failureKind` の型は共通・分類器は provider 固有（M4.4 の比較表）の、分類器側の穴**（executor 間の非対称）。
  直し方: claude の分類器で認証切れ（`OAuth session expired` / `could not be refreshed` など）を permanent にし、
  実際のエラー本文を fixture にした Test を足す。codex 側も同じ観点で見直す。
  ⚠️ 分類の変更は executor の変更（M5 のやらないこと）なので M5 では直さない。clipboard 経路のテストを同じコミットで通し直す（不変条件5）。
- 対処（2026-10-15・BL-238 の枠の段階1）: 実物（`runs/claude/2026-09-30T07-35-32-246Z-research.jsonl`）を読むと、assistant イベントに
  **構造化された `error: "authentication_failed"`** が載っていた（result は subtype "success"・api_error_status null）。分類器はこの欄を見ておらず、
  本文の `authentication_failed` の照合は本文にその語が無いので当たらなかった。`classifyFailure` に `errorCode`（assistant の `error`）を渡して正とし、
  本文の `failed to authenticate|oauth session expired|could not be refreshed` を保険に足した。Test 242（実物の fixture）。判定を外すと 242 が落ちることを確認（変異）。
  codex 側は同じ観点で見直した: 実行記録 194 回に認証切れの実例は無く、パターンは据え置き（実例が出たら fixture を足す）
- Status: resolved (2026-10-15)

## BL-278

- Source: 2026-10-06 の implementation（`runs/codex/2026-10-06T05-21-32-031Z-implementation.jsonl`）の所要の調査 / 起票 2026-10-06・人間が承認
- Severity: Major
- Trigger: **すぐ**（人間の判断で修正に着手。反映は research が走っていない時点）
- Summary: **e2e の手順（runtime `instructions/local-environment-detail.md` の「実装フェーズでそのまま使う手順」）の後始末が戻らず、毎回コマンドの上限（約 120 秒）まで待つ。**
  バックエンドを `Start-Job` で起動し、`finally` の `Stop-Job` / `Remove-Job -Force` で止める形。2026-10-06 の implementation では
  上限で打ち切られたコマンド 6 回のうち 4 回（#34 / 52 / 54 / 56）が、**テスト自体は通過した後**（例: 24 passed）に後始末で止まっていた。
  1 回あたり約 2 分、このタスクで約 8 分。research がこの手順を codex-prompt へそのまま写すので、e2e を流すタスクすべてに効く。
  直し方: 起動したプロセスを ID で控え、終了時にプロセスツリーごと止める（待たずに止める）。別ポートで検証してから反映する
- 対処（2026-10-06）: runtime の手順を `Start-Process -PassThru -WindowStyle Hidden` で起動し、`finally` で `taskkill /PID <Id> /T /F` に変えた
  （`versions.instructions.local-environment` 5 → 6。runtime のみ・assets には環境固有ファイルを置かない＝不変条件7）。
  手元の実測（ポート 5055・e2e の代わりに即終了するコマンド・同じバックエンド）: 準備完了まではどちらも約 49 秒、
  **後始末は旧 `Stop-Job` 24.6 秒 → 新 `taskkill` 0.4 秒**、プロセス終了まで 74 秒 → 49 秒。どちらも 5000 番の解放・dotnet の残存なし。
  今日の codex のログでも、手順書どおり `Start-Job` で起動した 4 回はすべて上限で打ち切られ、codex が自分で `Start-Process` に切り替えた 7 回はすべて上限前に戻っていた。
  反映は research の実行が終わった後（17:42）。⚠️ その直前の research が書いた codex-prompt.md には旧手順が写っている（このタスクの implementation は旧手順のまま）
- 訂正（2026-10-06 同日）: 停止は `taskkill /T /F` ではなく、**codex がサンドボックスの中で 7 回すべて通した形**
  （`Get-NetTCPConnection -LocalPort 5000` の持ち主と、起動した dotnet を `Stop-Process -Force`）に揃えた。
  `taskkill` はサンドボックスの中で動くか未確認だったため。手元の実測でこの停止も約 1 秒・ポートの解放・残存なし。版は 6 のまま（v6 を使った実行はまだ無い）
- 効果（2026-10-09 集計）: 10-07 以降の codex の実行 12 回で、e2e のコマンドが上限で打ち切られた（exit 124）のは **0 回**
  （before: 10-06 の 1 タスクで 4 回・約 8 分）。**効果確定**
- Status: closed (2026-10-09・効果確定)

## BL-279

- Source: 同上（15:17〜15:51 の空白）/ 起票 2026-10-06・人間が承認
- Severity: Major
- Trigger: **すぐ**（人間の判断で修正に着手）。BL-238 と同じ executor 整備の枠
- Summary: **codex が最終メッセージ（`turn.completed`）を出した後もプロセスが終了せず、aiw が完了を記録できないまま待ち続けた。**
  2026-10-06: codex の最終メッセージは 15:17:34、aiw は 15:17:33 まで出力を記録した後、`exec.completed` を残していない。
  人が Ctrl+C を 2 回押して止めた（A21・記録を残さない経路）。15:51 に `aiw run implementation` で再開。
  ⚠️ 当初の仮説「孫プロセスが stdout の口を握って `close` が来ない」は実験で否定した（Node → 中継役 → 本体の 3 段で、
  中継役の終了・kill のどちらでも `close` は 2ms 以内に来た。本体も一緒に終わったためと推測しているが、未確認）。
  したがって**終わらなかったのは codex 自身**（中継役 `node codex.js` か本体）と見ている。理由は時刻の無いログからは特定できない。
  直し方: 最終イベントを受け取った後、一定の猶予（例: 120 秒）で `close` が来なければ、子を止めて**完了として**扱い、
  `meta.lingeringAfterCompletion` 等で Event Log に残す（黙って直さない）。成否は従来どおり validator が決める。
  claude executor にも同じ形（最終の `result` イベントの後）があるので対称に入れるかを同時に判断する（BL-221 の規律）
- 対処（2026-10-06）: `src/engine/executors/linger.ts` の `createLingerGuard` を codex / claude の両方に入れた（対称）。
  最終イベント（codex: `turn.completed` / claude: `result`）を受け取ったら猶予 120 秒のタイマーを始め、それまでに `close` が来なければ子を止めて、
  **中断ではなく完了（claude は result のとおり）として**返す。`meta.lingeringAfterCompletion: { graceMs, killed }` を Event Log に残し、画面にも1行出す。
  最終イベントより前の固まりは扱わない（見張りの担当のまま）。Test 234（codex）/ 235（claude）。変異（finalSeen を外す）で 234 が落ちることを確認
- Status: resolved (2026-10-06)

## BL-280

- Source: 同上（BL-279 の帰結の検討）/ 起票 2026-10-06・人間が承認
- Severity: Major
- Trigger: BL-279 を直すとき、または implementation の所要が総上限の 90% を超えたとき
- Summary: **implementation の作業（約 56 分）が総上限（60 分）の手前まで来ていた。総上限に当たると auto は設計どおり即時に1回再試行する
  （A13a）ので、ほぼ出来上がった成果物を最初からもう 1 時間かけて作り直すことになる。**
  今回は人の Ctrl+C（15:21:31 の総上限より前）で結果的に避けた。上限に近づいた主因は BL-278 の待ち（約 8 分）とフル e2e の試行（約 2 分）。
  論点: (1) 最終イベントを受け取った後の打ち切りを総上限と同じ扱い（即時再試行）にしない（BL-279 とセット）
  (2) 作業の途中で総上限に当たった場合も、成果物が既にあるときの再試行が「作り直し」でよいか（再実行可能性の不変条件2 との関係を設計で詰める）
- 進捗（2026-10-06）: **(1) は BL-279 で対処済み**（最終イベントの後、猶予 120 秒で完了扱い。総上限より前に猶予が切れる限り、即時再試行に入らない）。
  ⚠️ 最終イベントが総上限の 120 秒前より後に来た場合は、猶予より先に総上限が撃つので従来どおり中断・即時再試行になる（残る穴）。
  (2) は未着手（設計の論点）
- Status: open（(2) が残る）

## BL-281

- Source: 2026-10-06 の research（`runs/claude/2026-10-06T08-03-41-309Z-research.jsonl`・39 分）の所要の調査 / 起票 2026-10-06・人間が承認
- Severity: Major
- Trigger: すぐ（人間の判断で修正に着手）
- Summary: **research が context-package を token-range の上限に収めるため、自前の近似で測っては少しずつ削るのを 16 周繰り返していた。**
  ツール呼び出し 143 回のうち #94〜143（約 3 分の 1・往復の回数からの推定で約 13 分）が、`wc -c` / `grep -o "[ -~]" | wc` で見積もっては
  50〜100 文字ずつ Edit で削る作業だった（自前の見積もり「約 3,340 トークン」から始めている）。research は aiw の見積もり関数を使えないので、
  BL-210 の「書く側は測らない」の帰結として、validator と合わない近似で手探りしていた。
  research の所要は出力トークンにほぼ比例（1 分あたり約 4,400 トークン）し、10-06 の 3 回は 27.5 / 35.9 / 39.0 分と総上限 40 分の手前まで伸びていた。
- 対処（2026-10-06）:
  1. **`aiw tokens <file...>`**（読むだけの CLI）: validator の `estimateTokens` / `estimateTokensBySection` をそのまま呼び、合計・宣言された範囲と残り・
     セクション別の内訳（大きい順）を出す。見積もりの複製ではない（BL-210 の方針と整合）。Test 236
  2. runtime の research の `bashAllow` に `node tools/aiw/dist/cli.js tokens:*`、local-environment（v7）に測り方の節（`cd` を挟まずルートから・BL-209）
  3. research Skill v8: 「validator と同じ見積もりで測る・自前に近似しない」「上限の 8 割を超えたら内訳を見て一度でまとめて削る」
  効果の観測は次の research（削り直しの周回数と所要）。⚠️ 上限そのもの（runtime で 1,500 → 3,000 に引き上げられたまま）の扱いは人間の判断待ち（BL-210）
- 効果（2026-10-09 集計・research 8 回）: **測り方は直った**（`aiw tokens` と validator の値は一致し、提出時の token-range は 7 タスクとも一発で通過）。
  **削り直しの周回は残った**: `aiw tokens` の呼び出しは 16 / 3 / 22 / 13 / 12 / 12 / 14 / 6 回。どの回も 1,500〜2,000 で書いてから
  1 回 20〜100 トークンずつ削り、上限の 97〜99%（1,483〜1,500）に着地している。Skill v8 の「8 割を超えたら一度でまとめて削る」は守られていない。
  10-07 の 1 回は 2,930 から 16 周削る途中で総上限 40 分に当たって落ちた。→ **BL-283**
- Status: resolved (2026-10-06)・効果は部分的（測り方は確定・周回は BL-283 へ）

## BL-282

- Source: 2026-10-08 の FEAT-review-feedback-1008 / TASK-2026-10-08-row-type の implementation（Event Log の `auto.stopped` A25 が 18:17 / 18:20・日本時間）/ 起票 2026-10-09・人間が承認
- Severity: Major
- Trigger: すぐ（人間の判断で修正に着手）
- Summary: **consumer-presence が `ac-manifest.json` の `consumerChecks[].root` にファイル（`MotodumoriTab.tsx`）を渡され、
  走査（`readdirSync`）が `ENOTDIR` の例外で落ちて、稼働中の auto を 2 回止めた。** 人が手で implementation を進めて回避した。
  この validator は 2026-09-01 の修正後が初計測の期間で、クラッシュで落ちると検出力の計測自体を汚す。
- 対処（2026-10-09）: 両面で直した（pathBase と同じ型）。
  1. エンジン: root が実在するファイルなら、その check を `consumer root must be a directory, not a file: <root>` の**理由付き failed** として返し、
     ほかの check は続けて検査する（`onViolation: report` のままなので halt しない）。**ファイル単体の検査には広げない**（manifest の意味論を広げる変更なので今はしない）
  2. 書き手: implementation Skill v7 に「`root` はディレクトリを指す。ファイルを書かない」を1行
  Test 237。修正を外すと本番と同じ `ENOTDIR` で落ちることを確認（変異）
- Status: resolved (2026-10-09)

## BL-283

- Source: BL-281 の効果の集計（2026-10-09・research 8 回）/ 起票 2026-10-09・人間が承認
- Severity: Major
- Trigger: 今週中（人間の判断）
- Summary: **research が context-package を上限の 97〜99% まで詰める山登りをやめない。** `aiw tokens` の呼び出しは 1 回の research で 3〜22 回。
  1,500〜2,000 で書いてから 20〜100 トークンずつ削り、1,483〜1,500 に着地する。Skill v8 の「8 割を超えたら一度でまとめて削る」は守られていない。
  10-07 の 1 回は 2,930 から 16 周削る途中で総上限 40 分に当たって落ちた（**周回の無駄がタスク落ちに及んだ初例**）。
  ⚠️ 指示をもう1枚足す（「下書きを 1,200 に収めよ」等）**はしない**——既存の指示が守られていない実測の上に同種の指示を重ねるのは、
  「ドキュメントは破られる」の教訓への逆行（人間の判断）。指示では止まらない圧（上限まで情報を詰めたい vs 超過は halt）として構造で扱う。
- 方針（人間の決定・2026-10-09）: (b) を先に実測し、それから (a) を実装する
  - (b) 1,500 が今の research に合っているかの再計測: 直近の research で**削られて消えた内容**をサンプルで見る。
    価値ある情報が削られているなら上限を上げる（その場合も (a) は入れる）。9 月以降、パリティ表・Trigger 照合・推奨付き Open Decisions と
    書く内容を増やしたのに器を据え置いた経緯がある
  - (a) 上限に**目標帯**を併設: validator の pass 条件は上限のまま。`aiw tokens` に目標帯（例: 上限の 75〜90%）を表示し、
    Skill は「目標帯に入ったら削るのをやめる」。山登りの終了条件を上限への漸近から帯への到達に変える（締めるのではなく、やめ時を与える）
- (b) の結果（2026-10-09）: **上限 1,500 は据え置き。** 10-07〜08 の research 7 回（打ち切りの 1 回は別枠）で削られた 6,608 字を分類した:
  言い換え・語尾の圧縮 45% / 重複 18% / 具体的な参照 18% / 根拠 9% / 検証手順 6% / 注意書き 1% / その他 3%（字数ベースの概算）。
  根拠・参照・注意・検証手順に当たるものも 8 割強は `codex-prompt.md` に同じ内容があり実装者へ届いていた（一部は推定）。
  届かなくなったのは 7 回で約 300〜350 字（見積もりで約 80〜90 トークン）で、重要度は低い（読むだけの参照・C# を触らない判断の根拠など）。
  削る周回の中で行番号の誤りの訂正・`## Modify` の漏れの追加も起きていた（副次効果）。⚠️ 見積もりは `max(ceil(文字数/4), 語数)` なので、
  上限 1,500 は日本語でおよそ 6,000 字（最終形は 5,848〜5,969 字）
- (a) の対処（2026-10-09）: `src/engine/tokens.ts` に `tokenTargetBand` / `describeTokenRange`（帯は上限の 75〜90% を上限から導く・数値を二重に持たない）。
  `aiw tokens` の判定文と JSON（`target`）に帯を出し、超過時は「帯の上端まで あと N 以上・目安 約 4N 字」を一度に削る量として出す。
  **validator の pass 条件は上限・下限のまま**（Test 238 が「帯より上でも上限内なら pass」を固定）。research Skill v9 は v8 の「8割を超えたら一度で」を
  **置き換え**（足していない）、local-environment v9 は出力の説明に帯を追記。
  ⚠️ 帯の上端（1,350）は今の着地点（1,483〜1,500）より約 150 トークン（約 600 字）小さい。超過した下書きからは今より多く削ることになるので、
  削られる内容の質は次の集計で見る
- 効果の観測（次の research から）: `aiw tokens` の呼び出し回数・削り直しの Edit の回数・最終のトークン数（帯に入ったか）・research の所要
- 効果（2026-10-15 集計・research v9 の 12 回）: 周回は減った（`aiw tokens` 2〜12 回・中央値 約 6。前は約 12）が、**帯に入ったのは 1 回だけ**。
  11 回は 1,403〜1,479（上限の直下）で止まった。
  ⚠️ **原因は実装時に私（Claude）が足した出口。** 人間の設計は「目標帯に入ったら削るのをやめる」だったのに、`aiw tokens` に「上限内・帯より上 → 削らなくてよい」、
  Skill に「上限内なら削らない」を足した。research は上限の直下まで小刻みに削ったところでこの出口から抜けていた——**設計を骨抜きにしていた**のは指示の不遵守ではなく実装の追加
- 訂正（2026-10-15）: `describeTokenRange` は帯より上なら上限の内外を問わず「帯まで一度で削る（あと N 以上）」を出す。research Skill v10 / local-environment v10 も同じ文言へ。
  Test 238 の期待値を訂正（上限内・帯より上で「削らなくてよい」を出さないことも固定）。判定（validator の pass 条件）は不変。
  上限内で書き上がった下書き（直近では 1,462 / 1,403 / 1,463）も帯まで一度削ることになる
- Status: open（(ii) の合格判定待ち・次の research 6 回）
- 効果（2026-10-19 集計・research v10 の 6 回）: **全 6 回が帯の上端ちょうど（1,349〜1,350）に着地した。** `aiw tokens` の呼び出しは 10〜21 回（v9 は中央値 約 6・v8 は約 12）で、**周回は増えた**。
  所要は 19〜31 分（v9 は 12〜37 分）。どの回も 1,550〜1,880 で書いてから 1 回 10〜100 ずつ削り、上限の直下で止まっていた v9 と同じ形で、今度は帯の上端へ漸近した。
  **しきい値は、置いた場所が山登りの新しい目標になる**——「やめ時を与える」は終了点を動かしただけで、小刻みに削る行動は変わらなかった。次の手は人間の判断待ち
- 判断（2026-10-19 人間）: v8→v9→v10 の3点で「どこに線を引いても線まで小刻みに漸近する」と分かった——しきい値ではなく**行動様式**の問題。
  残った唯一の構造仮説「どこをどれだけ削るか決めずに削っている」を (ii) で試す。(iii) を合格基準、(i)（v9 へ戻す）は (ii) で周回が増えた場合だけの保険
- (ii) の対処（2026-10-19）: `allocateCuts`。帯より上のとき、帯の**中央**まで削る量を各セクションの大きさに比例して割り当て、`aiw tokens` が
  「削減の割り当て（帯の中央 N まで・合計 M。各セクションを1回ずつ書き直してから1回だけ測る）」を出す（JSON は `allocation`）。判定文の目標も帯の中央へ。
  research Skill v11 / local-environment v11 は v10 の行を**置き換え**（足していない）。validator の判定は不変。Test 238 を更新
- **合格基準（2026-10-19 人間の決定・先に固定）**: 次の research 6 回で `aiw tokens` の呼び出しの**中央値が 4 回以下**（測る→割り当てを見る→削る→確認、の理論往復数）。
  満たさなければ (ii) も行動を変えられなかったと判定し、**(iii) を正式採用**——「周回はモデルの性癖として受け入れ、着地点の改善（1,460→1,350）だけを成果とする」と記録して closed。
  これ以上この問題に枠を使わない（所要 19〜31 分は変わっておらず実害は小さい）。(ii) で周回が増えたときだけ (i) に戻す

## BL-284

- Source: 2026-10-13 の FEAT-tougai-yosan-design-align の fix（`runs/codex/2026-10-13T03-55-22-865Z-fix.jsonl`）/ 起票 2026-10-13・人間が承認
- Severity: Critical（無人運転が黙って止まる）
- Trigger: すぐ（人間の判断で修正に着手）
- Summary: **codex は 13:22:34（日本時間）に `turn.completed` を出して作業を終えたのに、aiw は `exec.completed` を記録しないまま約 2 時間固まった。**
  BL-279 の猶予（120 秒で子を止める）も、総上限（60 分）の見張りも効かず、`auto.stopped` も残らなかった。人が 15:16 に auto を再起動し、fix が最初からやり直しになった。
  原因（実験で再現・確認済み）: executor は子の `close` だけを待っていた。`close` は「子が終了し、**かつ** stdio の口がすべて閉じた」ときにしか来ない。
  codex がテスト中に起動した vite（`::1:5175` / `5176`・12:56〜57 起動）が生き残り、継承された出力の口を握ったため、子が終わっても `close` が来なかった
  （最小の再現: 子は 299ms で `exit`、孫が生きている間 `close` は来ない）。止める相手の子はもう終わっているので、猶予の kill も見張りの abort も効かない。
  ⚠️ BL-279 で「孫が口を握る」仮説を否定したのは、孫が子と一緒に終わる形だけを試したため。**孫が生き残る形**では成り立つ
- 対処（2026-10-13）: `src/engine/executors/linger.ts` に `waitForChild`。終了は `exit` で知り、`close` は `exit` の後 10 秒（`DEFAULT_STDIO_DRAIN_MS`）だけ待つ。
  来なければ口をこちらから閉じ、**終了コードどおり**（claude は result どおり）に返す。`meta.stdioHeldAfterExit: { drainMs }` を Event Log に残し、画面にも1行出す（黙って直さない）。
  codex / claude の両方（対称・BL-221）。生き残った孫は止めない（誰のものか executor には分からない）。
  Test 239（codex・**本物の子と孫**で再現）/ 240（claude）。直しを外すと 239 は孫の寿命（4 秒）まで返らず、240 は返らないまま固まることを確認（変異）
- 残り: 猶予の kill / 見張りの abort が止めるのは中継役（`node codex.js`）だけで、`codex.exe` 本体と孫は残りうる（Windows はプロセスツリーを止めない）。
  今回は実害を確認していないので起票のみ。残った vite は e2e の 5173 とは別ポートで、今回の再実行の邪魔はしていない
- Status: closed (2026-10-19・効果確定)
- 効果（2026-10-19 集計）: `stdioHeldAfterExit` が **2 回発動**（10-15 10:24 と 10-19 03:15 の implementation。どちらも linger の猶予も発動）。
  2 回とも完了として記録されて review へ進んだ。直す前なら 10-13 と同じく固まっていた形
- 効果確定（2026-10-19 人間）。closed（残りのプロセスツリーの件は「残り」のとおり別に扱う）

## BL-285

- Source: 2026-10-13〜14 の Event Log（`Unexpected token` の json-schema の失敗 6 件・halt 4 件）/ 起票 2026-10-14・人間が承認
- Severity: Major（中身は正しいのに halt して auto が止まる）
- Trigger: すぐ（人間の判断で修正に着手）
- Summary: **codex が PowerShell 5.1 で書いた JSON の先頭に UTF-8 BOM が付き、`JSON.parse` が落ちて halt した。** BOM は文字コードの付け足しで中身ではない
  （RFC 8259 も読む側が無視してよいとする）。書き手への指示を足す案は採らない——codex は既に BOM なしで書こうとして揺れており、指示では止まらない（BL-283 と同じ判断）。
  10-13 から出始めた理由は特定できていない → **KI-10**（分かったこと・読めなかったことを分けて記録）
- 対処（2026-10-14）: `src/engine/jsonText.ts` の `parseJsonText` に JSON を読む口を1つにまとめ、先頭の BOM を1つだけ取り除く
  （validators の json-schema / artifact-contract / manifest の読み込み / schema 本体、status.ts の current-status、postActions、state.ts、gitScope の baseline、auto のロック）。
  **読む口を1つにした理由**: validator だけ BOM を許すと「検証は通ったのに遷移の読み込みで落ちる」食い違いが生まれる（変異で確認: status.ts だけ戻すと本番と同じエラーで落ちる）。
  判定は変えない（BOM 付きでも schema 違反は違反・BOM 以外の壊れた JSON も従来どおり）。無視したときはメッセージ「（先頭の BOM を無視した）」と
  `detail.bomIgnored: true` を残す（黙って直さない）。Test 241
- 観測: **BOM 検出件数/週**（`validation.completed` の `detail.bomIgnored`。KI-10 に数え方）
- Status: closed (2026-10-19・効果確定。原因は KI-10 で未特定のまま)
- 観測（2026-10-19）: BOM の検出は 10-15〜10-19 で implementation 2 回（10-16 06:54 / 08:40）×（ac-manifest.json と ac-result.json）= 4 件。halt は 0 件
  （直す前の 10-13〜14 は halt 4 件）。current-status.json の BOM は 0 件

## BL-286

- Source: 2026-10-15 / 10-16 の implementation（Event Log の `auto.stopped` A17・2 回）/ 起票 2026-10-19・人間が承認
- Severity: Major（エラーでない停止がエラーとして表示される）
- Trigger: すぐ（人間の判断で修正に着手）
- Summary: **implementation の codex が「IIS Express を停止して『停止済み』と知らせてください」と人に頼んでターンを終え、status を書かずに終わった。**
  auto はこれを A17（無進行・exit 5）として止め、「executor が status を書かなかった」と表示した——実際の意味は「人の作業が要る」でエラーではない。
  A17（status なし終了）の正体が「エージェントの怠慢」ではなく「人間への作業依頼」だった初のケース。原因は local-environment-detail の規則
  「IIS Express は人間が止める。AI は止めない」で、`.cs` を変えるタスクでは毎回起こりうる
- 対処（2026-10-19）: エンジンに汎用の**起動前チェック**だけを作った（人間の設計どおり）。
  1. `steps.<id>.preflight`: `[{ command: [argv…], onFail: pause, message, timeoutMs? }]`。aiw auto が exec の直前に実行し、exit 0 以外・実行できない・時間切れなら
     exec せずに**人の作業待ち（A26・終了コード 0・drive へ戻る）**で止まる。記録は `auto.preflight`。コマンドは argv でシェルを通さない（KI-08）。
     書き損じはロード時に落とす。clipboard のステップでは効かない（STEP_KEYS_INEFFECTIVE_ON）。`src/engine/preflight.ts`
  2. A17 の表示に「人に作業を頼んで終わった可能性もある（aiw log <step> で最後の発言を確認）」を足した（preflight で拾えない、タスク途中で人の作業が発生する同型への手当て）
  3. runtime（workflow v14）: implementation / fix に `.ai-workflow/config/preflight-iis-express.ps1`。context-package の `## Modify` に `.cs` があり、
     かつ IIS Express が動いているときだけ exit 1（`.css` / `.csproj` / Reference は数えない）。IIS Express という名前は runtime の値にだけ現れる（不変条件7）。
     手元で3つの分岐（.cs なし / .cs あり・IIS なし / .cs あり・IIS あり〔node.exe を iisexpress.exe の名前で動かした代役〕）を確認
  Test 246（A26・exec しない・drive へ戻る・実行できないコマンド・書き損じ）/ 247（A17 の表示）。preflight を外すと 246 が落ちることを確認（変異）
- Status: resolved (2026-10-19)

## BL-287

- Source: 人間の次の枠の指定（小枠B: task-planning の executor 化 + 整形契約）/ 起票 2026-10-19・人間が承認
- Severity: Major
- Trigger: すぐ（設計 → 承認 → 実装）
- Summary: **task-planning を claude executor で無人実行し、依頼の整形に契約を付ける。** 設計は `docs/design-task-planning.md`。
  M4 完了の記録の「自動化しない判断済み」は task-planning については理由なきスコープ外だった（design-claude-executor の決定ログで訂正）
- 対処（2026-10-19）:
  1. 整形契約: `current-task.md` に R / O / AC の ID・`## Request Mapping`（依頼 → 写像先）・`### Added Requirements`（依頼に由来しない要件を根拠つきで）。
     新しい validator 型 `request-mapping`（halt）が表の完全性だけを縛る: 表がある・写像先が空でない・ID が実在する・書式と重複・
     どの行からも指されず Added にも無い R（依頼にない要件）。内容の妥当性はゲート①で人間。テンプレートだけでは通らない（BL-213 の教訓）
  2. executor: runtime の task-planning を claude（Read / Grep / Glob / Edit・Bash なし・Edit は current-task.md / current-status.json / feature.md）・effort high・**auto なし**
  3. スタブ: new-task の後も claude の task-planning ならスタブを作る（`via: new-task`）。feature.md は `stub: true` の opt-in（0 バイトは単一タスクと同じ意味）
  4. Skill: task-planning v1 新設 / prompts v5（見出しの一覧の再記述を削除）/ research v12（照合の分担・AC の ID の引き継ぎ）/ review v8（G の逃げ道の1句）/ templates.currentTask v3
  5. Test 248（契約の故障注入3ケース: 写像漏れ / 架空 ID / 依頼にない要件・テンプレートは通らない）/ 249（task-planning の halt と、clipboard の設定でも同じ契約）/
     250（new-task のスタブ・clipboard では作らない）。検査を外すと 248・249 が落ちることを確認（変異 2 種）。旧書式の current-task を使う既存テストを新書式へ
- 観測（executor 化の後・目安 n=5）: ゲート①の却下率と理由（対応表の取りこぼしか）/ request-mapping の halt の件数と内訳 / task-planning の所要。
  その後に `auto: true` への組み入れを別に判定する（research と同じ段階制）
- Status: resolved (2026-10-19・観測待ち)

## BL-288

- Source: 人間の次の枠の指定（小枠A: reflection の executor 化 + 知識の差分サマリ）/ 起票 2026-10-19・人間が承認
- Severity: Major
- Trigger: すぐ（設計 → 承認 → 実装）
- Summary: **reflection を claude executor で無人実行し、知識ファイルの差分を人間に見せる仕組みとセットで入れる**（M4 の再検討条件そのもの）。設計は `docs/design-reflection.md`
- 対処（2026-10-19）:
  1. スナップショット: 入るとき（遷移・new-task）に、そのステップの inputs ∩ outputs を `runs/snapshots/<step>/` へ撮る（宣言から導く・知識ファイル名はエンジンに無い）。
     今の宣言では reflection（context / learnings / backlog / research/）と task-planning（feature.md）が当たる。clipboard でも撮る
  2. 差分サマリ: run の検証の前に `runs/snapshots/<step>/knowledge-diff.md`（**異常候補が先頭**: BL の二重・既存 BL の消失・Summary が既存と同じ BL・大幅削除 ≥30 行・大量追加 ≥80 行。
     無ければ「異常候補なし」）。ファイルごとの増減・BL の追加 / 状態の変化 / 削除・差分の本文（300 行まで）。Event Log `knowledge.diff`。A1 の1行・drive のゲート・aiw run にも要約
  3. 承認ゲート（reflection・timing after・onReject rerun）。却下では今の状態を `runs/snapshots/<step>-rejected-<時刻>/` へ**退避**してからスナップショットへ戻す（`knowledge.restored`）
  4. archive: `knowledge-diff-<step>.md` と退避した状態を archive へ随伴、`runs/snapshots/` は `discardSnapshots`（archiveArtifacts の後）で消す
  5. task-metadata.json: claude のとき 0 バイトのスタブを置くので、reflection に json-schema（緩い schema・新設）を足し、json-schema は 0 バイトを「空」と言う
  6. runtime: executor claude・effort high・**auto: true**（ゲートが無人の知識汚染を構造的に防ぐ・人間の裁定）。reflection Skill v7（research/ の新規メモは learnings の「メモ候補」へ）
  7. Test 251〜254（スナップショット / 差分と異常候補 / **故障注入の一周: 却下 → 退避 → 戻し → 再実行 → 差分が初回と独立** / 2 タスク連続と task-metadata の空）。
     却下の戻しを外すと 253 が落ちる（BL が二重になる）ことを確認（変異）。reflection を通す既存テスト 4 ファイルは「承認まで進める」補助関数へ
- 観測（executor 化の後）: **承認 / 却下の比**（数十タスクで却下 0 なら「異常候補ゼロなら自動承認」をデータ付きで再検討）・却下の理由（差分のどこを見たか）・
  異常候補の件数と的中・差分の大きさ・所要・`nextPhaseId` の書き漏れの halt が消えたか（before: 9 回中 8 回）・「メモ候補」が実際にメモ化された率
- Status: resolved (2026-10-19・観測待ち)

## BL-289

- Source: 2026-10-20 の人間の問い（feature のフェーズが長い・effort を下げたら短くなるか）/ 起票 2026-10-20・人間が承認
- Severity: Minor
- Trigger: すぐ（人間の指示）
- Summary: **codex（implementation / fix）の effort を aiw から指定できなかった。** フェーズの時間で一番大きい implementation（25〜100 分）が、どの effort で走っているかも
  記録に残っていなかった（`--ignore-user-config` なので、ユーザー設定ではなくモデルの既定＝gpt-6.1-sol は medium で走っていたと推定）
- 対処（2026-10-20）: `steps.<id>.effort` → `settings.codexEffort` を `-c model_reasoning_effort=<値>` で渡す。未指定なら渡さない。記録は `meta.effortRequested`。
  値はロード時に検査。0.160.1 で low の受け付けと、不正値が invalid_request_error（permanent）になることを実測。Test 255 / 256。設計は design-codex-executor の「effort を設定できるようにした」
- runtime の値: **まだ入れていない**（今までどおりモデルの既定 medium）。下げるかは実験で決める（人間の判断待ち）
- 実験の開始（2026-10-20 人間の指示）: runtime に `settings.codexEffort: low`（workflow v17）。測るのは implementation / fix の**編集・思考の時間**（exec の時間 − testlog のコマンドの時間）と Fix 率。
  before（medium・FEAT-grid-common の implementation 6 本）: 編集・思考 6.4 / 15.3 / 12.2 / 14.1 / 12.1 / 14.5 分（中央値 約 13 分）。Fix 率の上昇か短縮なしなら外す。
  ⚠️ 同じ日に E2E の回し方（BL-290）も変えたので、比べるのは E2E を除いた編集・思考の部分だけ（集計スクリプトは exec − testlog で分けられる）
- Status: resolved (2026-10-20・値の実験は人間の判断待ち)

## BL-290

- Source: 2026-10-20 の implementation の時間内訳の集計（FEAT-grid-common の 6 本）/ 起票 2026-10-20・人間が承認
- Severity: Major（1 フェーズ約 2 時間 20 分のうち、implementation の 65% が E2E）
- Trigger: すぐ（人間の指示）
- Summary: implementation 234.6 分の内訳 = E2E 151.4（65%）/ build 7.5（3%）/ その他のコマンド 1.1 / 編集・思考 74.6（32%）
  （Event Log の exec の時間と、`tools/testlog.ps1` が各コマンドのログに残す開始・終了の時刻から算出）。E2E が大きい理由は2つ:
  (1) 途中のフェーズでフル e2e（1 回 15〜17 分）が流れていた——ただしこの feature では、フル e2e を見た後に feature.md へ「最後のフェーズで 1 回」を書き足したので違反ではない（人間の説明）。
  一般の規則が Skill に無かった / (2) 直すたびに複数 spec の組（約 7 分）を流し直していた（move-d で 3 回）
- 対処（2026-10-20）: research Skill v13（feature の途中のフェーズではフル e2e を要求しない・最後のフェーズで 1 回・Required Tests に1行）/
  implementation Skill v8・fix Skill v8（再実行は落ちた spec だけ・まとめた組は最後の 1 回・e2e のフル実行は Required Tests に従う・unit / build の一式は毎回）。
  「最後の一式1回を省略した完了報告は不完全」（人間の注文の1行）は、unit / build の一式として残している（弱めていない）
- 観測: 次の数フェーズで implementation の E2E の時間と回数（同じ集計で並べる）
- 別件（記録のみ）: 1 コマンドの上限（約 120 秒）がもう効いていない（15〜17 分のコマンドが最後まで走った）。Skill の「上限で打ち切られたら NOT VERIFIED」の前提が変わっている。いつから・なぜかは未調査
- Status: resolved (2026-10-20・観測待ち)

## BL-193

- Source: TASK-2026-09-15-execution-budget-failing-specs / current-review.md Backlog 候補 2（Major M1）
- Severity: Major (deferred)
- Trigger: **次に `tests/`（gitignore 配下）の変更を含むタスクで、最終フル e2e を要求するとき**
- Summary: **`tests/` が gitignore のため、フル e2e を流したツリーを SHA で特定できない。** 更新日時の一覧が唯一の手段だが、今回は作業開始時に取っていたため、フル実行のあとに調査用の変更を撤回した（＝最終フルが納品ツリーではなかった）ことを成果物から検知できなかった。
  **対処**: フル実行の直前に、対象ディレクトリの更新日時とハッシュを証跡として残す運用へ寄せる。research の `# Required Tests` の手順に組み込むか、`tools/aiw` の verify-local で自動取得するかを決める（後者は aiw 側の変更）。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-233

- Source: TASK-2026-09-24-diff-scope-alias / current-review.md `## Backlog`
- Severity: Minor
- Trigger: `scope-violation-report.md` に `## Declaration Issues` が出た最初の 3 タスクを終えたとき
- Summary: `unresolvedDeclarations` は「実在しないパス」を集めるため、**まだ作っていない新規ファイルを `## Modify` に宣言する通常の運用でも載る。**
  雑音が多ければ `Declaration Issues` の文面か収集条件を調整する。⚠️ **実運用でどれだけ雑音が出るかは未測定**（research が backlog 送りを予告していた項目）。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-234

- Source: TASK-2026-09-24-diff-scope-alias / current-review.md `## Backlog`
- Severity: Minor
- Trigger: 次に `versions.skills.*` のどれかを意図して bump するとき
- Summary: `tools/aiw/test/review-executor.test.ts:230` が版数をリテラルで固定しているため、**意図した bump のたびに必ず 1 回赤くなる**（今回がまさにそれ。`5` → `6` で落ちた）。
  テスト自身のコメントは「契約は『値』ではなく『SKILL.md と versions が同じコミットで動く』こと」と書いている。**その契約を直接検査する形**（SKILL.md の変更と版数の変更が同じ未コミット集合に載っているか）へ置き換えれば、この定期的な赤は無くせる。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-235

- Source: TASK-2026-09-24-diff-scope-alias / current-result.md `## Manual Verification Required`
- Severity: Minor
- Trigger: 次に `tools/aiw` のテストを全件流すとき（緑なのに exit 1 になったら）
- Summary: ⚠️ **`tools/aiw` のテストは 228 件すべて pass でも、プロセスの終了コードが 1 になる。**
  原因は Test 174 の**終了後に起きる非同期の `ERR_STREAM_WRITE_AFTER_END`**。集計は緑なので、終了コードだけを見ると「落ちた」と誤読する。
  ⚠️ **切り分けは未着手**（本タスクの Fix Scope 外だった）。直すか、少なくとも「集計が緑なら成功」と判断する手順を書き残す。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-244

- Source: TASK-2026-09-25-test-hardening / current-review.md `## Backlog`（research-findings.md `# Open Decisions` D-1 からの申し送り）
- Severity: Major (deferred)
- Trigger: 次に `tools/aiw`（エンジン）を触るタスク枠が開いたとき
- Summary: `BL-201` は人間の決定により**案 A（親リポジトリの `tools/testlog.ps1`）**で解消したが、
  **案 A には構造的な弱点が 2 つ残る**:
  (1) ⚠️ **`/tools/` は親リポジトリで gitignore なので、ラッパ自身が履歴に残らず、消えても誰も気づかない。**
  (2) ⚠️ **research が `# Required Tests` に `testlog.ps1` 経由の呼び出しを書かない限り呼ばれない**ので、
  次のタスクで黙って保存が止まる（＝ review がまた実行結果を再現できなくなる）。
  恒久化には**案 B（executor が step ごとに shell 出力を `runs/<taskId>/` へ自動保存）**が要る。
  ⚠️ 本タスクは `tools/aiw/` を触らない決定（AC-04）だったので着手していない。
  ⚠️ 着手するときは `BL-241`（`npm test` 一式が executor の上限 ~120 秒を超える）と併せて見る。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-249

- Source: TASK-2026-09-26-lock-force-release / 運用（本セッションで 9 回 halt）
- Severity: Minor
- Trigger: 次に `tools/aiw` を触るタスク枠が開いたとき、または token-range の halt がもう一度出たとき
- Summary: **`context-package.md` の `token-range`（上限 1500）超過での halt が常態化している。**
  本セッションだけで 9 回、直近は 1 回の resume で収まらず 4 回削った。
  ⚠️ 原因は `## Modify` の**フルパス・略記禁止**の規則で、13 ファイルの宣言だけで**上限の 2 割近く**を食うこと。
  ⚠️⚠️ **上限の緩和は不変条件で禁止されている**（「上限は Codex の焦点を守るための制約であり緩和しない」）ので、
  取りうるのは **`# Files` の節をトークン計算から除く**案（`tools/aiw` 側）。
  上限の趣旨（長文を読ませない）を保ったまま、繰り返しの halt だけを消せる。
  ⚠️ **削るたびに宣言の情報が落ちる**ので、運用でしのぐほど危ない。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-252

- Source: TASK-2026-09-28-subtotal-rate / current-result.md `## Risk Areas`（AC-09 が NOT VERIFIED）
- Severity: Minor
- Trigger: 次に「禁止ファイルに差分が無い」を AC に書くとき、または溜まった未コミット差分をコミットするとき
- Summary: ⚠️⚠️ **作業ツリーに無関係の未コミット差分が溜まりすぎて、「このタスクは触っていない」を `git diff` で示せない。**
  2 タスク連続で同じ理由の `NOT VERIFIED` が出ている
  （`TASK-2026-09-26-lock-force-release` の AC-08 / 本タスクの AC-09）。
  現状の回避策は **(a) 実装開始時刻より前の mtime** と **(b) 実装中に取った `git status --short` のログ**の
  2 つで裏取りすることだが、⚠️ **毎回 review 側の工夫に依存している。**
  ⚠️ **根本の対処は溜まった差分をコミットすること**（`Front.csproj` の publish 対策・`.gitignore` 3 件・
  工種別予算管理表の AG Grid 化と背景色修正・引用廃止・束 1〜5・FEAT-ex-session6 の 3 フェーズ）。
  それまでは **AC に「`git diff` が空」と書かず、「開始時刻より新しいファイルの一覧」を根拠に指定する**。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-291

- Source: TASK-2026-10-07-misc-dialogs-ag-grid / reflection（知識ファイルの巻き戻りを検出）
- Severity: Major (deferred)
- Trigger: 次に `tools/aiw` を触るタスク枠が開いたとき、または reflection の追記がまた消えたとき
- Summary: ⚠️⚠️ **phase 4 の reflection が書いた `context.md` / `learnings.md` / `backlog.md` の追記が、phase 5 の fix 開始直後に 3 ファイルとも古い版へ戻されて消えた。**
  `context.md` と `learnings.md` の mtime は同時刻 2026-10-07T09:23:37Z。直前の 09:22:57Z に `approval.rejected review`（`rejected via drive`）、
  09:23:04Z に `baseline.captured fix`、09:23:16Z に fix の Codex 起動。Codex の fix ログ（`runs/codex/2026-10-07T09-23-16-082Z-fix.jsonl`）には
  この 2 ファイルを書くコマンドが見当たらない。**`aiw reject`（drive）か fix 開始時のエンジン処理が、作業ファイルを古いスナップショットから戻している疑い。**
  ⚠️ 知識ファイルは reflection の唯一の出力先なので、黙って戻ると次のタスクに知識が届かない（不変条件 2「再実行可能性」の前提も崩れる）。
  → エンジンの reject / drive / fix 開始の経路で、`.ai-workflow/` 直下のファイルを書き戻す処理が無いかを確かめる。今回の消えた内容は phase 5 の reflection で復元済み。
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-313

- Source: TASK-2026-10-13-tougai-save-messages / current-review.md ## Backlog 2
- Severity: Minor
- Trigger: 次に当該予算費消管理表の表示仕様を変えるタスクに着手するとき
- Summary: FEAT-tougai-yosan-design-align は phase 1〜4 が未コミットのまま積み上がり、「phase N 直前」の画面を再現できないため前後比較の画像が取れなかった（phase 4 の AC-14 が NOT VERIFIED）。phase 着手時に before を撮る、または phase 境界でコミットする
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-329

- Source: TASK-2026-10-15-koushubetsu-columns / current-review.md ## Backlog（Minor m1）
- Severity: Minor
- Trigger: 次に `# Acceptance Criteria Matrix` へ「既知の `BL-xxx` 以外の失敗が増えない」型の AC を入れるとき
- Summary: `context-package.md` の `## Ignore` が `backlog.md` を除外したまま「既知 BL 以外の失敗が増えない」AC を課すと、実装側は既知失敗の中身を読めず構造的に NOT VERIFIED しか書けない（今回 1 回発生）。該当 `BL-xxx` の症状（spec:行・期待値と実測値）を `# Constraints` か `## Reference` へ 1 行ずつ転記する運用にする
- Note (2026-10-20): `.ai-workflow/backlog.md` から移管（人間の指示: aiw 系はアプリの backlog から隔離して件数に数えない）
- Status: open

## BL-291

- Source: 2026-10-20 の人間の依頼（reflection がたびたび halt する原因の調査）/ 起票 2026-10-20・人間が承認
- Severity: Major
- Trigger: すぐ（人間の指示）
- Summary: 10-19〜20 の reflection 周りの halt 3 件は、原因がそれぞれ別だった:
  1. 10-19 10:40 reflection `post-action-failed`（`unknown postAction discardSnapshots`）: 小枠A で runtime の設定に新しい postAction を足したとき、
     **動いていた aiw は古いコードのまま**だった（設定がコードより先に行った）。resume 1 回で通過・再発しない。
     **教訓: 新しい postAction / validator を runtime の設定へ足すのは、動いている auto が止まってから**（Claude の作業手順の誤り）
  2. 10-19 10:48 task-planning `validation-failed`（request-mapping）: 写像先 `G（phase 1 で完了）` の括弧の注記を、検査が空白で区切って ID として扱った（Claude の実装の不具合）
  3. 10-20 03:47 reflection `validation-failed`: feature-continue の `nextPhaseId` の書き漏れ。手貼りの頃から reflection の halt 11 件中 9 件で、executor 化でも消えなかった。
     指示はプロンプトの後半に1か所だけで、Skill の手順には無かった（この回の reflection は大きなファイルの読み込みで 3 回エラーを出しながら作業していた）
- 対処（2026-10-20）: (2) request-mapping は写像先の括弧の中を注記として読み飛ばす（括弧の外の ID は従来どおり検査）/
  (3) reflection Skill v8 の手順6に1行・json-schema の nextPhaseId の書き漏れの halt に feature.md から正解の候補を添える（表示だけ・判定は同じ・`detail.suggestedNextPhaseId`）。根治は BL-239 /
  あわせて knowledge-diff の research/ のファイル名に git の引用符が残る表示の不具合も直した（`research/x.md"` → `research/x.md`）。
  Test 248（注記）/ 257（候補の表示・ファイル名）。それぞれ直しを外すと落ちることを確認（変異 3 種）
- Status: resolved (2026-10-20)

## BL-292

- Source: 2026-10-20 の人間の指摘（reflection のとき「人の番に戻ります」の文言が出たまま）/ 起票 2026-10-20・人間が承認
- Severity: Minor
- Trigger: すぐ
- Summary: drive の auto モードは、止まった理由に関係なく「↩ 人の番なので drive に戻ります。」とだけ出していた。reflection が自動になった（小枠A）後も、
  手で貼る番に戻ったように読めた。README にも「clipboard のステップ（reflection など）」が残っていた
- 対処（2026-10-20）: `returnToDriveLine` で理由を出す（承認待ち / 人の作業待ち / 手で貼るステップ / 区間外 / 完了。例「↩ reflection の承認待ちなので drive に戻ります。」）。
  README の記述を今のゲート（task-planning / research / review / reflection の知識の差分）と preflight に合わせた。Test 258。Test 231 の見張り（異常停止では戻らない）を新しい文言でも効くように更新
- Status: resolved (2026-10-20)

## BL-293

- Source: 2026-10-20 の人間の依頼（archive に入れるときに feature のフォルダ名に日付と時間を入れてほしい）/ 起票 2026-10-20・人間が承認
- Severity: Minor
- Trigger: すぐ
- Summary: feature の archive は `archive/<featureId>/` で、いつの feature かがフォルダ名から分からなかった（並べても時系列にならない）
- 対処（2026-10-20）: `featureArchiveDir`（postActions.ts）に置き場を1つにまとめた。新しい feature は `archive/<日付時刻>-<featureId>/`
  （日付時刻は最初にその feature を archive したとき・UTC・タスクの退避先 `<日付時刻>-<task>` と同じ書式）。同じ feature の2本目以降のフェーズと feature.md も同じフォルダへ。
  以前からある日付なしの `archive/<featureId>/` は同じ feature のものとして使い続ける（進行中の feature を 2 つに割らない）。単一タスクは `archive/single/` のまま。
  タスクの退避（archiveArtifacts）と feature.md の退避（archiveFeature）の両方がここを通る。Test 259（日付なしに戻すと落ちることを確認）。テストの置き場の組み立ても同じ関数へ
- 既存の archive の改名（2026-10-20 人間の依頼）: 日付なしの 35 フォルダを `<日付時刻>-<名前>` へ改名した。日付時刻は中のタスクのフォルダで一番古いもの
  （新しい規則の「最初に archive したとき」と同じ意味）。中身に日付時刻が無い 2 つ（`FEAT-yosan-torikimegai-modonyu-input` / `fuzzy-search-selectors`）は中身の名前の日付に `T000000`。
  知識ファイル `research/tougai-design-conformance.md` の参照 4 か所を書き換え（古いタスクの `runs/` の記録は書き換えていない）。対応表は runtime の `runs/archive-rename-20261020.json`（元に戻すとき用）。
  1 回目は `FEAT-table-ag-grid` で EPERM（中のファイルを何かが開いていた）になり 27 件で止まった。スクリプトを「失敗は飛ばして記録」に直して流し直し、全件通った
- Status: resolved (2026-10-20)

## BL-371

- Source: 2026-10-20 の人間の依頼（aiw pr コマンドの v1。設計 → 承認 → 実装）/ 起票 2026-10-20・人間が承認（設計 docs/design-pr.md・Q1〜Q4 の裁定）
- Severity: Minor
- Trigger: すぐ
- Summary: タスク完了後、成果物から PR の説明文を機械生成し、Azure DevOps に draft PR として作る。公開は人間の操作に残す
- 対処（2026-10-20）: `aiw pr [--dry-run] [--check] [--task]`（src/engine/pr/）。state.json を読まず変えない・PAT は env のみで出力の最終段で伏せる・
  REST 直叩き・冪等キーはブランチ（同じブランチの draft PR は説明文だけ更新。公開済み・人が直した PR は触らない）・添付失敗は保存先パスへ縮退・
  4000 字へ段階的に削る・欠けた記録は「記録なし」。archiveArtifacts に context-package.md を追加。review Skill v9（after スクショ）。Test 260〜275
- 残り（人間の作業）: Stage 0（PAT を GUI でユーザー環境変数へ → `aiw pr --check` → settings.pr を貼る）と、初回の実 PR（実タスクで `--dry-run` を読む → 本実行 → 生成キーの往復を実測。Azure DevOps が説明文を正規化すると 2 回目以降が「人が直した」扱いになる）
- Status: resolved (2026-10-20・Stage 0 と初回の実 PR は未実施)

## BL-372

- Source: 2026-10-20 aiw pr の実装中に発見（archive の実データで AC の集計を確かめたとき）/ 起票 2026-10-20・承認待ち
- Severity: Major
- Trigger: 次に `aiw status --summary`（summary.ts）か sections.ts の `countTriStatus` を触るタスクの前
- Summary: 実物の `current-result.md` の `## Acceptance Criteria Verification` は表（`| AC-01 | PASS | ... |`）で書かれていることが多く、
  `countTriStatus` は `Status:` 行しか数えないので 0 件になる。`aiw status --summary` の Claimed の AC 三値が、表で書かれたタスクでは全部 0 に見える
  （FEAT-grid-common surface-bc の実データで確認: 表では 6 / 0 / 14、countTriStatus は 0）。aiw pr は表も読む `countTriStatusAny` を使っている。
  summary を `countTriStatusAny` へ替えるのは表示の変更だが、承認ゲートで人間が見る数なので単独のタスクで
  （`## Manual Verification Required` が散文で書かれると countListItems が 0 になる同じ形の盲点もある）
- Status: open

## BL-373

- Source: 2026-10-20 aiw pr の実装中に発見（設計 §C の実現性の確認）/ 起票 2026-10-20・承認待ち
- Severity: Minor
- Trigger: aiw pr を実タスクで 3 回走らせ、`--dry-run` の「画像の添付」の枚数を数えた後
- Summary: review は spec を書けず Bash も書き込み不可なので、after スクショを撮れるのは「spec が出力先を env で受け、`after-` で始まる名前で書く」画面だけ。
  2026-10-20 時点で env を受ける spec は 4 本（`grid-surface-unify` / `grid-cell-validation` / `budget-row-hierarchy` の 2 箇所）で、
  `after-` で書くのは `grid-surface-unify`（`GRID_SURFACE_SHOTS`）の 1 本だけ。さらに env を前置したコマンドが review の許可（`./tools/nrun.cmd:*`）に当たるかは未実測。
  枚数が少なければ設計 §C の案 (b)（製品側の playwright に after スクショの reporter を入れる製品タスク）を起票する。案 (c)（review に cp を許す）は採らない
- 対処（2026-10-23・人間の判断）: 撮影を review から implementation（変更前・変更後）と fix（変更後の撮り直し）へ移した（設計 §A-6）。
  implementation は spec / スクリプトを書けるので env 対応の spec に依存しない。review Skill v10 は「撮らない」。観測は baseline の世代注記
- Status: resolved (2026-10-23・撮影の担当替えで解消。撮れた枚数は実タスクで観測)

## BL-374

- Source: 2026-10-20 aiw pr の設計（docs/design-pr.md §A-3・§D・§E-3・§E-4 の v2 判定）/ 起票 2026-10-20・承認待ち
- Severity: 仕様判断
- Trigger: aiw pr で実 PR を 3 本作った後
- Summary: v1 で見送った 4 件の判定。(1) 説明文の自由記述を人がどれだけ直したか（`--dry-run` の「内部用語の残り」の語数と、公開時の差分）→ 多ければ reflection に客先向けの要約欄を足す
  (2) 起動を reflection の postAction か aiw auto の終端へつなぐか（失敗は report・pendingTransition の冪等チェックポイントに乗せる）
  (3) feature の全フェーズを集約した説明文（今は最新フェーズの 1 タスク分）(4) タスク開始時のブランチ作成の postAction（aiw が初めて git に書く経路。diff-scope の baseline との順序を別に設計する）
- 経過（2026-10-23）: 初回の `--dry-run` を見た人間の判断で、説明文を「対応した内容（依頼文のチェックボックス）」と「画面（変更前 → 変更後）」の 2 節にした（設計 §A-6）。
  (1) は自由記述をほぼ説明文から外したことで小さくなった（依頼文は客先の言葉）。(3) は依頼文が feature 全体の依頼で、スクショも feature の全タスクから集めるので、実質的に満たした。(2)(4) は open のまま
- Status: open（(2) と (4)）
