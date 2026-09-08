# knowledge ファイル監査（1回目・2026-09-08）

**計測と報告のみ。** 統合・削除・index 化・Skill 変更・エンジン変更は一切していない。
GC や index 化の要否は人間が判断する。本書は判断材料の提示までを担う。

⚠️ **本書は独立リポジトリ（AIW）に置くため、対象ファイルの中身は
「ワークフロー機構に関する記述」だけを引用し、客先ドメインの記述（画面名・業務語）は
引用しない。** タスク見出しを引くときは ID と行番号のみを使う。

計測日: 2026-09-08 / 対象ルート: `.ai-workflow/`（旧 `.ai-workflow2/` からリネーム済み）

---

## 0. 照合キーの共通条件

| 項目 | 値 |
| --- | --- |
| 対象ファイル | `learnings.md` / `context.md` / `backlog.md` / `backlog-open.md`（+ `research/`） |
| 実行ログ | `.ai-workflow/runs/execution-log.jsonl`（4,007 行）、`runs/codex/*.jsonl`（70 本）、`runs/claude/*.jsonl`（13 本） |
| タスク数 | `transition` かつ `to == "complete"` を 1 タスクと数える（全期間 69 本） |
| archive | `archive/<feature>/<stamp>-task` を数えて 81（`transition` 基準の 69 と一致しないのは、`complete` に至らず archive されたものを含むため。**本書の分母は 69 に統一**） |
| バージョン | workflow 5 / skills research 4・review 3・reflection 4 / instructions local-environment 4 |

---

## 1. 現状の棚卸し

### 1.1 サイズと構成

計測: `wc -c` / `wc -l` / `grep -c "^## "` / `grep -c "^### "`（2026-09-08 の作業ツリー）

| ファイル | bytes | 行 | `##` | `###` | 位置づけ |
| --- | ---: | ---: | ---: | ---: | --- |
| `learnings.md` | 342,581 | 4,285 | 93 | 224 | タスク単位の教訓。`##` = 1 タスク |
| `context.md` | 246,500 | 2,882 | 30 | 41 | プロジェクトの現在の姿 |
| `backlog.md` | 218,343 | 2,196 | 150 | 0 | `## BL-xxx` が 1 エントリ |
| `backlog-open.md` | 14,625 | 130 | 4 | 23 | **派生（生成物）。** `.gitignore:48` で除外されており git 管理外 |
| `research/`（7 ファイル） | 107,929 | — | — | — | reflection の `optionalOutputs` |
| **3 ファイル計** | **807,424** | 9,363 | | | |

- `learnings.md` の `##` セクション本文は合計 161K **文字**（≒ 340KB。日本語 3 バイト/文字）。
  セクションの中央値は 1.4 KB、最大は 10.9 KB（`TASK-2026-08-07` のフェーズタスク）
- `backlog-open.md` は `backlog.md` の open 抽出。**独立した蓄積ではない**ので
  以降の成長率からは除外する

### 1.2 成長率

計測: `.ai-workflow/.git` の全 commit（14 本）に対し `git cat-file -s <commit>:<file>`。
現在値は作業ツリー（未コミット分を含む）。

| 計測点 | learnings | context | backlog | 計 | 累積タスク |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08-18 `78d871e`（版管理の初回） | 146,955 | 104,217 | 118,395 | 369,567 | 33 本経過済み |
| 2026-09-01 `9297d90` | 275,638 | 193,438 | 182,427 | 651,503 | +22 本 |
| 2026-09-08 作業ツリー | 342,581 | 246,500 | 218,343 | 807,424 | +14 本 |

**1 タスクあたりの増加**（分母は `execution-log.jsonl` の完了タスク数）:

| 区間 | タスク | learnings | context | backlog | 計 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 08-18 → 09-01 | 22 | 5.7 KB | 4.0 KB | 2.8 KB | **12.5 KB/本** |
| 09-01 → 09-08 | 14 | 4.7 KB | 3.7 KB | 2.5 KB | **10.9 KB/本** |

⚠️ **精度の限界（推定で埋めない）**:

- **計測点は 3 つだけ。** commit は 14 本あるが、うち 6 本（08-18〜08-31）は 3 ファイルとも
  サイズが 1 バイトも動いていない。**版管理下に置いてから 09-01 まで、変更がコミットされて
  いなかった**ため、中間の推移は**判定不能**
- **07-22〜08-18 の 33 タスク分は履歴が無い**（初回コミットが 08-18）。この期間の
  増加率は**判定不能**。08-18 時点の 369,567 bytes が 33 タスク分の蓄積だと仮定すれば
  11.2 KB/本になるが、これは**仮定であって実測ではない**
- 2 区間の実測（12.5 / 10.9）は近い。**「1 タスクあたり 11〜13 KB」は 2 点で一致した観測**
  であって、傾向の外挿ではない

---

## 2. 読み手の実測 ← 最重要

### 2-1. 宣言側

計測: `workflow.yaml` の `steps.<step>.inputs/outputs`、`prompts/*.md`、`skills/*/SKILL.md`、
`instructions/*.md`、`codex-system.md` を grep。

| ステップ | `context.md` | `learnings.md` | `backlog.md` | 宣言の所在 |
| --- | --- | --- | --- | --- |
| task-planning | **読**（必須） | — | **読**（optional） | `workflow.yaml:248,251` + `prompts/task-planning.md:16-17` |
| research | **読**（必須） | — | — | `workflow.yaml:286` のみ。**プロンプトには現れない**（下記 ⚠️） |
| implementation | — | — | — | 宣言なし |
| review | — | — | — | 宣言なし |
| fix | — | — | — | 宣言なし |
| improve-check | — | — | — | 宣言なし |
| reflection | **読 + 書** | **読 + 書** | **読 + 書** | `workflow.yaml:585-600` + `prompts/reflection.md:15-17,23` + `skills/reflection/SKILL.md:18,33-35` |

- `instructions/knowledge-files.md` が `context.md` / `learnings.md` の**書き方**を規定。
  結合されるのは **reflection のみ**（`workflow.yaml:583`）
- `instructions/backlog-rules.md` は reflection と review に結合。review は
  `## Backlog` の**書き手**であって `backlog.md` の読み手ではない
- `codex-system.md` に 3 ファイルへの言及は **0 件**（＝ codex には読めとも書けとも言っていない）

⚠️ **宣言と組み立ての不一致（1 件）**: research は `workflow.yaml:286` で `context.md` を
inputs に宣言しているが、**組み立て出力（27,293 bytes）に `context.md` という文字列が
入力として現れない**。`prompts/research.md` には `## Inputs` 節そのものが無く、
`## Output` から始まる。出力中の唯一の `context.md` 出現は
`instructions/local-environment.md` 本文の別件（E2E の artifacts 設定に関する記述）。
**inputs 宣言は engine 側の存在検査には効くが、プロンプトへは伝わらない。**

### 2-2. 実測側

計測: `runs/codex/*.jsonl` の `item.type == "command_execution"` の `command`、および
`runs/claude/*.jsonl` の `assistant` メッセージ内 `tool_use` の
`input.command / file_path / path / pattern / glob`。
ファイル名は**単語境界つき**で照合（`(?<![-\w])context\.md`)。
⚠️ 素朴な部分一致は `error-context.md`（Playwright の出力）を大量に拾うため、
最初の集計は無効として破棄した。

| ログ | 本数 | `learnings.md` | `context.md` | `backlog.md` | `backlog-open.md` |
| --- | ---: | ---: | ---: | ---: | ---: |
| codex（implementation） | 70 | **0 回** | 2 回 / 1 本 | 32 回 / 1 本 | 0 |
| claude（review 6 / improve-check 7） | 13 | **0 回** | 1 回 / 1 本 | 6 回 / 3 本 | 1 回 / 1 本 |

- codex の `backlog.md` 32 回・`context.md` 2 回は**すべて同一ログ内**で、
  パスが `.ai-workflow2/` 表記。**リネーム（09-02）より前の 1 タスクに集中**しており、
  常態ではない
- claude 側の内訳は review が `backlog.md` を 6 回（BL 番号の実在確認・gitignore の確認）、
  `context.md` を 1 回（識別子の grep）。**improve-check は 3 ファイルとも 0 回**
- **`learnings.md` は 83 本すべてのログで 0 回**

**research / task-planning は実行ログが存在しない**（clipboard executor のため）。
代替として組み立て出力を検査した:

| 検査 | 結果 |
| --- | --- |
| research 組み立て出力のサイズ | 27,293 bytes（`context.md` は 246,500 bytes） |
| `context.md` の固有文字列（110 行目冒頭 40 文字）で照合 | **不一致 = 埋め込みなし** |
| 出力中の `context.md` への言及 | 入力としての言及は **0**（2-1 の ⚠️ 参照） |
| task-planning 組み立て出力 | 1,919 bytes。`- user-task.md / context.md` と**入力として明記あり** |

→ **research が context を得る経路は、組み立て出力からは説明できない。**
`workflow.yaml` の inputs 宣言は engine の存在検査にしか効かず、プロンプトにも
Skill にも `context.md` を読めという指示が無い。実際に読まれているかどうかは
**実行ログが無いため判定不能**。読まれているとすれば、それは人間が対話セッションで
補っているためであり、**機構としては保証されていない**。

### 2-3. 結論

**書き手は毎タスクいる。読み手は、機構上は reflection ただ 1 つである。**

reflection は 3 ファイルを inputs にも outputs にも宣言しており、**自分が書いたものを
自分で読む**。それ以外で宣言があるのは task-planning（`context.md` 必須・`backlog.md` 任意）と
research（`context.md`。ただしプロンプトへ伝わっていない）で、どちらも実行ログを
残さないステップである。自動化された 3 ステップ（implementation / review / improve-check）は
**3 ファイルを宣言していないし、実測でも `learnings.md` を一度も開いていない**（83 本中 0 回）。

⚠️ **ただし「読まれていない」と「効いていない」は別である。** `learnings.md` の知見が
`instructions/` や Skill へ昇格して効いている可能性がある——実際
`local-environment.md`（14,026 bytes）は research プロンプトの **51%** を占めており、
`learnings.md` に書かれた種類の知見（E2E の落とし穴、node の版、実行手順）が
そこに移されている。**昇格した量と、昇格せず残った量の比は本監査では測っていない（判定不能）。**
「読み手がいない = 無価値」と結論するには、この比の測定が要る。

---

## 3. `learnings.md` の品質

### 3.1 機械計測: 陳腐化参照

計測: `grep -cE <pattern> <file>`

| パターン | learnings | context | backlog | 判定 |
| --- | ---: | ---: | ---: | --- |
| `\.ai-workflow2` | 10 | 3 | 11 | **陳腐化**（09-02 にリネーム） |
| `fix-package` | 0 | 0 | 0 | 撤去済み（KI「死んだ指示」で対処済み） |
| `testing` ステップ | 0 | 0 | 0 | 残骸なし |
| `KI-0[1-9]` | 0 | 0 | 0 | 残骸なし |
| `v0\.2` | 0 | 1 | 0 | context に 1 件 |
| `clipboard` | 13 | 13 | 7 | **陳腐化ではない**（research / task-planning / reflection は現在も clipboard） |
| `Status: resolved` の BL 番号への `learnings` からの参照 | 0 | — | — | 残骸なし |

**陳腐化の総量は小さい。** 3 ファイル合計で `.ai-workflow2` 24 行が最大で、
これは表記の問題であって内容の誤りではない（`backlog-open.md` 冒頭には
「以下の過去項目に出てくる `.ai-workflow2` は現 `.ai-workflow` を指す」という
但し書きが既にある）。

### 3.2 機械計測: 重複

計測: `###` 見出し 224 件と、箇条書き・強調行を含む 1,051 単位について、
正規化後の 3-gram Jaccard 係数。**同一 `##` セクション内の並記は重複と数えない**
（同じタスクの中で関連する記述が並ぶのは意図された形のため）。

| 単位 | 閾値 | 該当 |
| --- | --- | ---: |
| `###` 見出し同士 | ≥ 0.50 | **0 組** |
| 別タスク間の記述（1,051 単位） | ≥ 0.45 | **3 組**（最大 0.47） |

3 組の内訳（いずれも中程度の類似で、完全な重複ではない）:

1. `L522` ↔ `L2764` — `current-status.json` の `result` は `workflow.yaml` の
   `transitions` を見てから書く（前者は説明、後者は ⚠️ 付きの再発記録）
2. `L977` ↔ `L3204` — `## Manual Verification Required` へ回す前に自動化できないか疑う
3. `L3204` ↔ `L3593` — 同上の系列

**reflection の重複排除規則は守られている**と判断できる。より強い根拠は
**既存項目が後から追記されている**ことで、たとえば `L14`（`TASK-2026-07-22`）の
gitignore に関する項目には、**08-20 / 08-21 / 08-24 の 3 つの後日実測が
同じ項目の中に追記されている**。新しいタスクで同種の事象を踏んだとき、
新項目を足さずに古い項目へ追記する運用が実際に行われている。

### 3.3 サンプル読解（直近 20 セクション 66 KB / 古い 20 セクション 45 KB）

| 観点 | 直近 20 | 古い 20 |
| --- | --- | --- |
| (a) ほぼ同内容の重複ペア | **0**（機械計測と一致） | **0** |
| (b) 現在は無効な記述 | **1 件**（下記） | **0 件**（表記の陳腐化のみ） |
| (c)「次に行動が変わる」を満たさない項目 | **0**。全項目が `→ …する / …しない` の形 | **0**。同形 |

**(b) の 1 件**: `learnings.md:3422`

> `### ⚠️ improve-check は Critical しか見ない（構造上の穴）`
> （`:3426`）`**そして improve-check の判定条件は「Critical が解消されたか」だけ。**`

これは **2026-09-02 に解消済み**（improve-check Skill v3 で `## Fix Scope` の
`### Major` を判定対象に追加）。同項目は末尾に「対応方針は `BL-122`」と書いており、
**当時としては正しい記録**だが、現在の読者が真に受けると誤る。
⚠️ 本監査では**修正しない**（指示どおり）。

なお (c) について、機械的な近似カウントでは 494 の見出し・箇条書きのうち
245 の近傍に行動指示（`→` や「…する**」「…しない**」）が出現する。
ただしこれは**複数行にまたがる項目を過小に数える**ため、サンプル読解の結果
（20 + 20 セクションで該当 0）の方が実態に近い。**機械カウントは判定に使わない。**

---

## 4. 組み立てサイズの再計測

計測: `node dist/cli.js --root ../../.ai-workflow prompt <step> | wc -c`（2026-09-08）。
M2 時点の値は `docs/m2-prompt-decomposition.md` の表。

| ステップ | M2 時点 | 現在 | 差 | 主因 |
| --- | ---: | ---: | ---: | --- |
| research | 14,087 | **27,293** | **+94%** | `local-environment.md` が 14,026（出力の 51%） |
| improve-check | 3,360 | 5,634 | +68% | Skill v3（Major 判定の追加） |
| implementation | 7,197 | 11,612 | +61% | Skill v4（ac-manifest / ac-result） |
| review | 12,792 | 18,631 | +46% | Skill v3（Verification Data + パリティ監査） |
| fix | 6,613 | 9,028 | +37% | Skill v5（見送り記録・ac-result 再作成） |
| reflection | 13,457 | 16,632 | +24% | Skill v4（見送り Major の backlog 経路） |
| task-planning | （M2 表に無し） | 1,919 | — | Skill / instructions の結合なし |

**内訳（現在）**:

| ステップ | 計 | Project Instr. | Local Env | Skill | Step |
| --- | ---: | ---: | ---: | ---: | ---: |
| research | 27,293 | 0 | **14,026** | 11,385 | 1,471 |
| review | 18,631 | 7,918 | 0 | 8,856 | 1,648 |
| reflection | 16,632 | 6,427 | 0 | 8,109 | 1,876 |
| implementation | 11,612 | 3,360 | 0 | 6,935 | 1,124 |
| fix | 9,028 | 3,360 | 0 | 4,346 | 1,151 |
| improve-check | 5,634 | 0 | 0 | 3,741 | 1,733 |
| task-planning | 1,919 | 0 | 0 | 0 | 1,919 |

⚠️ **M2 の「-70%」は、モノリシックなプロンプトを分解して各ステップへ必要分だけ配る、
という配分の話だった。**上の増加は分解の後退ではなく、**Skill へ機能（監査項目・
契約・棚卸し）を足した結果**である。両者を同じ軸で比べないこと。
ただし **research は Local Environment が半分を占める**という新しい偏りが出ており、
これは M2 時点には無かった構造である。

---

## 所見（判断材料。実装はしていない）

**1. 最も安く直せる実害は「宣言と組み立ての不一致」1 件。**
research の `context.md` inputs 宣言はプロンプトへ伝わっていない（2-1 の ⚠️）。
KI-09 の系譜「宣言はあるが効いていない」の条件を満たす。
`prompts/research.md` に `## Inputs` を 1 節足すだけで閉じる。
**ただし「読ませるべきか」は別問題**——246 KB の `context.md` を毎回読ませるのは
research の焦点を損なう可能性がある。**「宣言を消す」も同じくらい妥当な選択肢**で、
どちらにせよ現状の宙吊りは解消したほうがよい。

**2. GC / index の判断には、本監査では測っていない数字が要る。**
「`learnings.md` の知見のうち、`instructions/` や Skill へ昇格して実際に配られている割合」。
これが高ければ `learnings.md` は**アーカイブ**であって作業ファイルではなく、
肥大は問題にならない（読み手がいないのは設計どおり）。低ければ、
**書いたものが誰にも届いていない**ことになる。この比は測定可能（昇格先の
`instructions/` と `learnings.md` の対応付け）だが、機械的には難しく、
サンプル読解が要る。**次の監査項目として推奨。**

**3. 陳腐化と重複は、現時点では GC の理由にならない。**
無効な記述 1 件・表記の陳腐化 24 行・別タスク間の類似 3 組（最大 0.47）。
342 KB に対してこの量は少なく、**reflection の運用は効いている**。
GC をやるなら理由は「品質」ではなく「サイズ」になる。

**4. サイズを問題にするなら、効くのは reflection の入力である。**
3 ファイルを毎回読むのは reflection だけなので、肥大のコストは reflection に集中する。
⚠️ **reflection は clipboard なので入力トークンの実測が無い（判定不能）。**
M4 で reflection を executor 化すれば測れるようになる。**測ってから決められる。**

**5. `backlog-open.md` は生成物であり、GC の対象ではない。**
`backlog.md` の open 抽出で 14.6 KB。git 管理外。
`backlog.md` 218 KB のうち Status が resolved / wontfix のものが大半を占める構造だが、
**その内訳は本監査では数えていない**（backlog の棚卸しは別テーマのため）。
