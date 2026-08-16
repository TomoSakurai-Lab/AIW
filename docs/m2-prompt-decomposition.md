# M2: Prompt Decomposition — 分類表と移行記録

M1 で肥大した Step プロンプトを責務別に分解する作業の**設計図であり、照合リスト**。

移行後に「元のプロンプトにあった指示が失われていないか」を確認するための正本。
Stage 3 で内容を動かすたび、この表の「状態」列を更新する。

## 分解先

| 現在の指示 | 移行先 |
| --- | --- |
| 今回の Task Summary / Scope / AC | Step Input / Artifact（既にそう） |
| 毎回同じ作業手順 | **Skill**（`skills/<step>/SKILL.md`） |
| プロジェクト恒久規則 | **Instructions**（`instructions/<name>.md`） |
| **環境固有の実行手順** | **local-environment**（`instructions/local-environment.md`・runtime のみ） |
| 出力形式 | Artifact Contract / JSON Schema（既存） |
| 禁止事項 | 実在する Permission / Validator |
| 遷移条件 / retry / model / session | workflow.yaml / Engine / model-policy / state |

`local-environment` は Stage 0 で新設した第4カテゴリ。理由は KI-01 の節を参照。

---

## 分解前の規模（2026-08-13 実測）

| プロンプト | bytes | assets との差 |
| --- | ---: | --- |
| research | 12,351 | **+3,946（runtime オーバーレイ）** |
| reflection | 10,308 | 同一 |
| review | 7,126 | 同一 |
| implementation | 4,467 | 同一 |
| codex-system | 3,052 | 同一 |
| fix | 2,440 | 同一 |
| improve-check | 2,364 | 同一 |
| task-planning | 2,339 | 同一 |
| review-audit | 1,137 | 同一 |

---

## 分類表

状態: ⬜ 未移行 / ✅ 移行済み / 🗑 削除済み

分類「**新規追加**」は、元のプロンプトに無く**分解時に足した**指示を指す。
移した指示と同じ表に並ぶと出所が分からなくなるため区別する。
新規追加をするときは、この分類で表に載せて完了報告でも明示すること
（M2 レビューで「出所不明の追加」として指摘された）。

### implementation.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| `.ai-workflow2/` 配下が対象ディレクトリ | 恒久規則 | Instructions | ✅ |
| Read: codex-system / context-package / codex-prompt | 手順 | Skill（Step にも一覧を残す） | ✅ |
| codex-prompt のタスクを実装。過去タスクを引き継がない | 手順 | Skill | ✅ |
| **current-result の必須見出し11個の列挙** | **契約の再記述** | **削除**（参照に置換） | 🗑 |
| AC ごとに1ブロック・三値・PASS へ丸めない | 手順 | Skill（三値の原則は Instructions） | ✅ |
| Evidence は実在するものだけ | 手順 | Instructions | ✅ |
| 各セクションの書き方（Change Map 等） | 手順 | Skill | ✅ |
| `result` 許可値 `implemented` のみ | 遷移条件 | **Step に残す** | ✅ |
| Prohibited: Scope 外変更 / 無関係リファクタ / 旧 `.ai-workflow/` 書き込み | 禁止事項 | Instructions（diff-scope が検査） | ✅ |
| `Manual Verification Required` / `Unresolved Decisions` を空にしたい誘惑への注意 | **新規追加**（Stage 3-1） | implementation Skill | ✅ |

新規追加の意図: 三値規律の強化。**M1 版の `implementation.md` には存在しない**。
「常に空になるのは、実際に何も無いのではなく書いていないだけのことが多い」という
実測の傾向に対する注意で、`## Acceptance Criteria Verification` の三値と同じ系統の規律。
機構ではないため、破っても止まらない（`docs/m2-mechanism-migration.md` の第2表）。

### fix.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| Read 4ファイル / Fix Scope のみ / Critical・Major 優先 | 手順 | Skill | ✅ |
| current-result を検証パッケージとして作り直す（見出し列挙付き） | **契約の再記述** | **削除**（参照に置換） | 🗑 |
| 触れていない AC を確かめずに PASS のまま残さない | 手順 | Skill | ✅ |
| `result` 許可値 `fixed` のみ | 遷移条件 | **Step に残す** | ✅ |
| Prohibited: Minor 修正 / スコープ拡大 | 禁止事項 | Skill（Fix Scope の読み方）+ Instructions | ✅ |
| Prohibited: `fix-package.md` を作らない | **死んでいる** | 🗑 削除 | 🗑 |
| Read の `test-report.md` を「Testing 失敗経由」と説明 | **死んでいる** | 🗑 verify-local 失敗時へ修正 | 🗑 |

### review.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| **current-review の必須見出し17個の列挙** | **契約の再記述** | **削除**（参照に置換） | 🗑 |
| 監査4セクションの具体的確認内容 | 手順 | Skill | ✅ |
| Fix 原因を `実装起因` / `research起因` に分類 | 手順 | Skill | ✅ |
| Inferred Behavior の算出根拠を検算 | 手順 | Skill | ✅ |
| `## Backlog` に入れる基準（Trigger 必須・Severity 語彙） | 恒久規則 | Instructions | ✅ |
| バックログ解消タスクでは新規 Minor を積まない | 恒久規則 | Instructions | ✅ |
| 許可値 `ready` / `fix-required`、`approved` は無効 | 遷移条件 | **Step に残す** | ✅ |
| 成果物をファイルに書くこと（970分停止の実測） | 手順 | Skill | ✅ |
| `fix-package.md` を生成しない | **死んでいる** | 🗑 削除 | 🗑 |
| 対象ディレクトリ（`.ai-workflow2` と旧 `.ai-workflow`） | 恒久規則 | Instructions（coding-rules と共有） | ✅ |

### improve-check.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| Critical 解消の検証手順 / NOT VERIFIED の扱い | 手順 | Skill | ✅ |
| `step` を書き直すこと（実測事故） | 手順 | Skill | ✅ |
| 許可値2つ・verify-local が検証を担う旨 | 遷移条件 | **Step に残す** | ✅ |
| 対象ディレクトリ | 恒久規則 | 🗑 削除（Skill / Step が `.ai-workflow2/` 付きの絶対表記で書く） | 🗑 |

### reflection.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| 責務境界（AI は書く / CLI が状態変更） | 手順 | Skill | ✅ |
| context.md / learnings.md の判定基準 | 恒久規則 | Instructions（knowledge-files） | ✅ |
| backlog.md の書式・Severity 語彙・Status 語彙・open 20件で警告 | 恒久規則 | Instructions（backlog-rules v2） | ✅ |
| research-findings の消し込み手順 | 手順 | Skill | ✅ |
| task-metadata.json のスキーマと tags 規則 | 出力形式 | Skill（schema 未整備のため） | ✅ |
| 重複を増やさない | 恒久規則 | Instructions（knowledge-files） | ✅ |
| 許可値2つ・nextPhaseId 必須 | 遷移条件 | **Step に残す** | ✅ |
| backlog 書式例の見出しが `## BL-046`（実 ID） | **死んでいる** | 🗑 `## BL-001` へ | 🗑 |
| 対象ディレクトリ | 恒久規則 | 🗑 削除（Input/Output を `.ai-workflow2/` 付きで書く） | 🗑 |

### codex-system.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| ワークフロー成果物を書き換えない | 恒久規則 | **codex-system に残す** | ⬜ |
| 出力言語（本文は日本語・見出しと Status は英語） | 恒久規則 | **codex-system に残す** | ⬜ |
| **current-result の見出し11個の再列挙** | **契約の再記述** | **削除** | 🗑 |
| e2e は1コマンド・`--retries=0`・範囲外を自己判断で足さない | 恒久規則 | Instructions（coding-rules v2） | ✅ |

### research.md

| 指示の要約 | 分類 | 移行先 | 状態 |
| --- | --- | --- | --- |
| **context-package / research-findings / codex-prompt の見出し列挙（23行）** | **契約の再記述** | **削除**（参照に置換） | 🗑 |
| 読者で成果物を分ける / AC Matrix の表形式 / `## Ignore` の列挙 | 手順 | Skill | ✅ |
| 波及ファイルの宣言規則（Stage 1 で追加） | 手順 | Skill | ✅ |
| 算出値の扱い（Source Requirements と Inferred の分離） | 手順 | Skill | ✅ |
| `# Required Tests` の既定（軽く。e2e は条件付き） | 手順 | Skill（コマンド実体は local-environment） | ✅ |
| UX 判断が必要なときは止める / 再実行時の注意 | 手順 | Skill | ✅ |
| 許可値 `research-complete` / `ux-decision-required` | 遷移条件 | **Step に残す** | ✅ |
| `./tools/nrun.cmd` / BL-050 / BL-054 / 絶対パス（runtime のみ） | **環境固有** | **local-environment** | ✅ |
| 対象ディレクトリ | 恒久規則 | 🗑 削除（Output を `.ai-workflow2/` 付きで書く） | 🗑 |
| Prohibited: 実装しない / 広範な探索をしない | 禁止事項 | Skill（目的の節） | ✅ |

---

## 契約の再記述 — 削除対象45行

| 出典 | 重複内容 | 見出し数 | 実削除行数 |
| --- | --- | ---: | ---: |
| research.md | context-package 10 + research-findings 8 + codex-prompt 5 | 23 | 23 |
| review.md | current-review（レベル・順序の説明付き） | 17 | 17 |
| implementation.md | current-result | 11 | 3 |
| fix.md | current-result（implementation と二重） | 11 | 3 |
| codex-system.md | current-result（三重） | 11 | 4 |
| **合計** | | **73** | **50** |

Stage 0 の見積は 45 行だった。実測 50 行との差は fix.md を数えていなかったため。

**`current-result` の見出しは3箇所に書かれていた。** M1 で契約を変えたとき、実際に3箇所とも
直している——つまり重複のコストを既に一度支払っている。M2 で
「1箇所（`workflow.yaml` の `artifacts`）+ 参照」へ集約するのが、この作業の最も具体的な成果。

Skill には**契約を再記述しない**。「`current-result.md` を契約どおりに書く
（構造は `workflow.yaml` の `artifacts` が正）」という参照に留める。

---

## KI-01 の解消: `local-environment.md`

`research.md` の runtime 差分 3,946 bytes は全て**環境固有の実行手順**:

- `./tools/nrun.cmd`（Volta shim 回避・BL-050）
- backend 事前起動の PowerShell ブロック（BL-054）
- 絶対パス、製品名、spec 名

### Skill にも Instructions にも置かない理由

| 候補 | 適否 |
| --- | --- |
| Skill | ✗ assets で配布される汎用手順。`aiw init` で他環境へ漏れる |
| Instructions（`coding-rules.md`） | ✗ 同上。かつ「プロジェクト恒久規則」であって「このマシンの制約」ではない |
| **local-environment** | ✓ runtime にのみ存在。assets には置かない（`.gitkeep` も置かない） |

### 何が変わるか

KI-01 の性質が **「同名ファイルの中身が違う」→「runtime にだけ在るファイル」** へ変わる。
`versions.prompts.research` が assets と runtime で同じ値を指したまま、
中身も同じになる。**バージョン比較が壊れなくなる**のはその帰結。

### 「不在は大きな音を立てる」原則への例外（申請・承認済み）

環境固有ファイルは**環境によって存在しないのが正常**なのでエラーにしない。
ただし静かな除外にはせず、組み立て出力の冒頭に1行残す:

```text
<!-- (no local-environment.md) — optional, not present in this environment -->
```

宣言は `optionalInstructions` で明示する（規約ベースにしない）。
`test/prompt-assembly.test.ts` の Test 84 がこの例外の挙動を固定している。

---

## 組み立て機構（Stage 2 で実装済み）

### 結合順序（固定）

```text
1. PROJECT INSTRUCTIONS — instructions/<name>.md      一般
2. LOCAL ENVIRONMENT   — instructions/local-environment.md
3. SKILL               — skills/<step>/SKILL.md
4. STEP                — prompts/<step>.md            固有
```

一般 → 固有。**最も具体的な Step 宣言（許可値・出力仕様）を最後**に置く。

### 宣言

```yaml
steps:
  implementation:
    skill: implementation
    instructions: [coding-rules]
    optionalInstructions: [local-environment]
```

| 宣言 | ファイルが無い場合 |
| --- | --- |
| `skill` | **エラー**（`PromptAssemblyError`） |
| `instructions` | **エラー** |
| `optionalInstructions` | 省略 + 出力に `(no <name>.md)` |
| 宣言なし | 従来どおり Step プロンプト単体（後方互換） |

### `aiw prompt` の設計変更

M0.4 では `aiw prompt` を「`workflow.yaml` を読まない」設計にしていたが、**M2 で撤回した**。
Skill 宣言は config にしか無く、読まなければ**手順が欠けたプロンプトを黙って出す**ため。
config が壊れていればこのコマンドは失敗するが、不完全なプロンプトを配るより失敗するほうがよい。

---

## 計測（M2.6）

分解前後のサイズは Stage 3 の各コミットで記録する。

| 指標 | 分解前 | 分解後 |
| --- | ---: | ---: |
| Step プロンプト合計 bytes（9ファイル） | 45,584 | **13,668**（-70%） |
| 分解先の合計 bytes（Skill 6 + Instructions 3 + local-environment） | — | 35,154 |
| 実際に配られる合計 bytes（8ステップの組み立て後の総和） | 45,584 | 60,980 |
| 契約の再記述として削除した行数 | 45（見積） | **50**（実測） |

3行目が増えるのは、共有している Instructions が**ステップの数だけ再送される**ため
（`coding-rules.md` は implementation / fix / review の3回）。1回の実行で読ませる量は
減っていない。**この作業の目的は総量削減ではなく、同じ規則の出どころを1つにすること。**

- `current-result` の見出しは 3 ファイル（implementation / fix / codex-system）に
  書かれていた → `workflow.yaml` の 1 箇所
- Backlog の基準は review、書式は reflection にあった → `backlog-rules.md` の 1 箇所
- 対象ディレクトリの注記は 5 ファイルにあった → `coding-rules.md` の 1 箇所
- 環境固有手順は `research.md` の runtime 版にだけ埋まっていた →
  `local-environment.md` として独立（KI-01 解消）

### ステップごとの実測

| ステップ | Step 単体 | 組み立て後 | 内訳 |
| --- | ---: | ---: | --- |
| implementation | 4,467 → **1,016**（-77%） | 7,197 | SKILL 2,372 + coding-rules 3,101 |
| fix | 2,440 → **1,055**（-57%） | 6,613 | SKILL 1,793 + coding-rules 3,101（共有） |
| review | 7,126 → **1,545**（-78%） | 12,792 | SKILL 3,516 + coding-rules（共有）+ backlog-rules 3,713 |
| improve-check | 2,364 → **1,289**（-45%） | 3,360 | SKILL 1,564（Instructions は宣言なし） |
| reflection | 10,308 → **1,780**（-83%） | 13,457 | SKILL 5,367 + backlog-rules 3,713 + knowledge-files 1,658 |
| research | 8,405 → **1,368**（-84%） | 14,087 | SKILL 7,310 + local-environment 4,718（runtime のみ） |
| codex-system | 3,052 → **2,139**（-30%） | —（seed。組み立て対象外） | テスト実行規則は coding-rules v2 へ |

research の「分解前」は assets 側の 8,405 bytes。runtime 側は環境固有のオーバーレイを
含めて 12,351 bytes だった（KI-01）。分離後は**両者が同一の 1,368 bytes** になり、
環境固有部分は runtime にしか無い `local-environment.md` へ移った。

組み立て後は一時的に増える。Instructions は複数ステップで共有するため、
移行が進むほど1ステップあたりの限界コストは下がる。**削減の目標は総 bytes ではなく
「同じ規則が何箇所に書かれているか」**であることに注意する。

> **計測方法**: 「組み立て後」は `aiw prompt <step>` の出力 bytes から末尾改行を除いた値。
> `coding-rules` は v2（3,101 bytes・codex-system のテスト実行規則を集約後）、
> `backlog-rules` は v2（3,713 bytes・reflection の書式と語彙を集約後）で測っている。
> 初出時に v1 の値で記録していたため、Stage 3 完了後の値へ更新した。

M2 世代の起点: `research v9` / 各 Skill v1 / `coding-rules v2` / `backlog-rules v2` /
`knowledge-files v1`。以降の比較はこの世代内で行う。

`research v8` は Stage 1（波及ファイルの宣言規則）の版であり、分解後は **v9**。
世代の境界は `docs/baseline.md` の「M2 世代の開始」を正本とする。

---

## M2 世代内での追加（由来の記録）

M2 レビューで確立した規約に従い、**指示の新規追加はここに由来を記録する**。

### 2026-08-14: fix の所要時間対策（実測 50 分 / うち e2e 反復 約 40 分）

**動機**: `TASK-2026-08-14-hishou-undo-redo` の fix が 50 分かかった。
Codex の rollout ログ実測で implementation 9.2 分に対し fix 59.5 分（時間 6.5 倍・
入力トークン 12 倍）。エージェント自身の事後分析で 5 つの非効率が挙がった。

| 追加した指示 | 分類 | 移行先 | 動機（実測） |
| --- | --- | --- | --- |
| `## Verification Data` から実データ値を取り、想定値を仮定しない | 手順 | **Skill**（fix v2） | 実値が本文にあったのに想定値で検証して手戻り |
| 検証の段階制（開発中は最小反復 / 揃ってからフル1回 / 一時コードは削除） | 手順 | **Skill**（fix v2） | フル e2e を 18 回実行 |
| e2e 規則を「最終検証」と「開発中の反復」で分離 | 恒久規則 | **Instructions**（coding-rules v3） | 「1コマンド」規則を反復にも厳密適用していた。規則の意図は「勝手にテストを増やすな」 |
| `## Verification Data` を必須セクション化 | 出力形式 | **Artifact Contract**（currentReview v5） | 「本文のどこかにある」→「契約で保証された場所にある」へ |
| Verification Data に実値を書く（抽象記述は不可） | 手順 | **Skill**（review v2） | 上とセット |
| E2E 操作の既知の落とし穴 8 件 | **環境固有** | **local-environment**（v2） | 1回の fix で 7 件をその場で踏んだ。fresh session なので次回も踏む |
| 落とし穴一覧を読むポインタ | 手順 | **codex-system**（seed） | 下記の注意を参照 |

**`## Verification Data` の位置**: `## Ready` の後・`## Fix Scope` の直前。
**fix が読むもの（Fix Scope とその検証データ）を隣接させる**ため。
今回の問題自体が「実値が本文のどこかにあって読み落とした」なので、
**読む場所の隣接性は機能の一部**という判断。

### ⚠️ 落とし穴一覧のポインタを codex-system へ置いた理由

当初 fix Skill への追加を検討したが、**実測で `local-environment` を組み立てるのは
`research` だけ**と判明した（`workflow.yaml` の `optionalInstructions`）。

| step | instructions | optional |
| --- | --- | --- |
| research | — | **local-environment** |
| implementation | coding-rules | — |
| fix | coding-rules | — |

落とし穴は **implementation でも踏む**（e2e とブラウザ実測は実装フェーズでも行う）ため、
fix Skill だけに書くと**半分しか塞げない**。
**`codex-system.md` は implementation と fix の両方の `inputs` に入っている唯一のファイル**
なので、そこへ**ポインタ1行**だけを置いた。**内容は local-environment に残す**
（環境固有の分類は変えない）。

⚠️⚠️ **未解決の宿題**: ポインタ方式は
**「Codex が自分でファイルを開きに行く」前提**であり、組み立て出力に本文は含まれない。
**次の fix で実際に読みに行くかを実測する。**
読みに行かないようなら、次の一手は
**`workflow.yaml` の `implementation` / `fix` の `instructions` へ
`local-environment` を追加する**（M2 の組み立て機構の設定1行）。

### 効果測定（次の fix で記録する）

| 指標 | 変更前（実測） | 目標 |
| --- | ---: | ---: |
| fix 1周の所要時間 | 50 分 | **10〜15 分** |
| e2e のフル実行回数 | 18 回 | **1 回** |
| 想定値の仮定による手戻り | あり | **無し** |
