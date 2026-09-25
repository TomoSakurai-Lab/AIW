# aiw auto 設計（M5）

**状態**: **承認済み**（2026-09-25。未解決の論点 8件すべて決着・#6 は修正つき）。
承認時の注文（判定器の統一を独立コミットにし、挙動が変わる点を列挙する）と、
反映作業中に見つかった初版の誤り2件（stale の判定位置・BL 番号）は本文へ反映済み。
故障注入リスト（24件）の合意だけが実装の開始条件に残っている。

**目的**: 承認ゲートの後の無人区間を、人間が `aiw exec` / `aiw run` を叩き続けなくても
完走させる。auto は**人間の代行**であり、判定には一切関与しない。

**参照実装**: `aiw drive`（`src/cli.ts` の `runDrive`）と `aiw next`（`nextSuggestion`）。
runtime root は `.ai-workflow/`（`.ai-workflow2/` から改名済み。古い文書のパスは読み替える）。

## 前提（確定済み・再検討しない）

| # | 前提 | 出典 |
| --- | --- | --- |
| 1 | **予算はステップ実行回数を主とする**。トークンは観測として記録し停止条件にしない（codex と claude で inputTokens の意味が違い、合算が定義から成立しない）。時間は watchdog が既に持つので二重にしない | M5 設計プロンプト |
| 2 | **無人区間**: 承認ゲート②（research 承認）→ ③（review 承認前で停止）、③承認 → reflection 手前で停止。ゲートと clipboard ステップは人間のまま | 同上 |
| 3 | 停止条件に「executor: clipboard のステップに到達」を含める | 同上 |
| 4 | 通知は最小: 停止理由の1行 + 終了コード。外部通知は作らない（deferred） | 同上 |
| 5 | **fixAttempts の有界・escalation halt・全 validator は不変**。auto は run を叩く人間の代行 | 同上 / CLAUDE.md 不変条件4 |
| 6 | **drive の骨格と `aiw status --summary` を再利用**する。同じループを二重実装しない | 同上 / 計画 M5「新しいコマンドを二重実装しない」 |

前提5 から導かれる、auto が**決してしない**こと（実装の防衛線として課題K に固定する）:

- 承認・却下（`approve` / `reject`）を呼ばない
- halt を resume しない（チェックポイント `pendingTransition` の resume だけは行う。drive と同じ）
- `recaptureBaseline` を呼ばない（`cli.ts` のコメント「M5 の aiw auto から呼ばれないようにするため」。Test 58 が import を監視）
- `report` 宣言の違反を停止へ格上げしない（判定の変更にあたる）
- state.json を自分で書かない（書くのは run / resume の既存経路だけ）

---

# Stage 0: 開始条件の判定（2026-09-25）

| 条件 | 状態 | 根拠 |
| --- | --- | --- |
| archiveFeature 改修のコミット・報告 | ✅ | `a86f06a`（本体）/ `37238d6`（resume の冪等性の穴を2つ塞ぐ + 2周目のテスト 169-172） |
| fix が codex に切り替わり、実測 n≥2 | ✅ **n=4** | runtime `workflow.yaml` の fix に `executor: codex`。Event Log の fix × codex の `exec.completed` は 4件（2026-09-24、所要 258〜1648 秒）、`exec.failed` は 0件 |
| BL-221 完了（特に signal） | ✅ | `3e1734f`。`codex.ts` が起動前に `req.signal?.aborted` を検査するようになった（Test 173）。BL-219（`4b53bed`）・BL-220（`5cb6b7a`）も done |
| M4 完了の決定ログ訂正 | ✅ | `e8a4caf`。`design-claude-executor.md` 1087行目に「⚠️ 訂正あり: 2026-09-25」 |

`npm test`: **228 / 228 pass**。

---

# 調査結果（実測）

## 1. 既存ループは2箇所にあり、順序がずれている

状態を読んで次の行動を決める判定は、`nextSuggestion`（engine.ts）と `runDrive`（cli.ts）に**別々に書かれている**。

| 判定の順 | `nextSuggestion` | `runDrive` |
| --- | --- | --- |
| 1 | halted | **ステップ未定義（完了 / 不明）** |
| 2 | pendingApproval | halted |
| 3 | pendingTransition | pendingApproval |
| 4 | 終端 / 不明 | pendingTransition |
| 5 | stale status | 実行（executor か clipboard） |

到達しうる状態（halt 中は currentStep が必ず定義済みのステップ）では結果は同じになる。
ただし engine.ts には、この判定を1箇所へ寄せた経緯のコメントが既にある
（「predicate が2箇所にあったことが順序のずれを許した」）。
**auto を3箇所目にしない**ことが課題E の出発点。

## 2. 状態の語彙: 実在するものと、計画書・指示文の語彙

| 実在（`types.ts`） | 値 |
| --- | --- |
| `state.status` | `ready` / `halted` / `awaiting-approval` / `running` |
| `HaltedReason` | `escalation` / `invalid-status` / `validation-failed` / `approval-rejected` / `post-action-failed` |
| run の結果（`PipelineOutcome.kind`） | `transitioned` / `awaiting-approval` / `halted` / `rerun` / `nothing` |

計画書 M5.1 と指示文にあるが実在しない、または意味が違うもの:

| 語彙 | 実態 |
| --- | --- |
| `awaiting-clarification` / `clarification-required` | **存在しない**（workflow.yaml・Skill・プロンプトを grep して0件） |
| `awaiting-ux-decision` / `ux-decision-required` | halt でも状態でもなく、**research → research の遷移キー**。research はゲート②を持つので、この結果でもまず承認待ちで止まる |
| `token-range` | halt 理由ではなく **`validation-failed` の一種**（validator の1つ） |

停止条件表（課題A）は実在する語彙で組み、上の3語は対応先を注記する。

## 3. 無人区間の境界と research（前提3だけでは足りない）

全ステップの宣言（runtime `workflow.yaml`・2026-09-25）:

| ステップ | executor | 承認 | retryPolicy | result → 遷移先 |
| --- | --- | --- | --- | --- |
| task-planning | clipboard | ①（rerun） | — | planned → research |
| **research** | **claude** | ②（rerun） | — | research-complete → implementation / ux-decision-required → research |
| implementation | codex | — | — | implemented → review |
| review | claude | ③（rerun） | — | ready → reflection / fix-required → fix |
| fix | codex | — | 初回 + 2 | fixed → improve-check |
| improve-check | claude | — | — | ready-for-reflection → reflection / fix-incomplete → fix |
| reflection | clipboard | — | — | feature-continue → task-planning / feature-complete → complete |
| review-audit | clipboard | — | — | audit-complete → complete |

⚠️ **research は M4 段階3 で `executor: claude` になった**（2026-09-14 から）。
前提3「clipboard ステップ到達で停止」は、research が clipboard だった時期の境界として正しかったが、
今は research を止められない。auto が research に到達する経路は現に3つある:

1. task-planning の承認（ゲート①）直後 — currentStep = research
2. ゲート②で `ux-decision-required` を承認した後 — research → research
3. ゲート②を却下（onReject: rerun）した後 — research を再実行

どれも前提2の区間の外にある。**区間の境界には、clipboard とは別の宣言が要る**（課題A の A3、未解決の論点 #1）。

## 4. 1タスクあたりの実行回数（予算の根拠）

Event Log の完了タスク 141件（reflection からの遷移で区切る）:

| 指標 | 全期間 | 2026-09-04 以降（n=41） |
| --- | --- | --- |
| 区間内（implementation / review / fix / improve-check）の run 回数 | 最小 2 / 中央 4 / p90 4 / **最大 8** | 最小 2 / 中央 4 / **最大 4** |
| 区間内の executor 起動（再実行を含む） | 最小 0 / 中央 1 / p90 4 / 最大 8 | 最小 1 / 中央 3 / p90 5 / 最大 7 |

**理論上の最大**（run 回数）: implementation 1 + review 1 + (fix + improve-check) × 3 = **8**。
全期間の観測最大と一致する。

1回の auto 起動は区間の片側しか走らない（ゲート③で必ず止まる）:

| 区間 | 起動1回での最大 run 回数 |
| --- | --- |
| ②→③（implementation → review） | 2 |
| ③→reflection 手前（fix ⇄ improve-check） | **6**（fix 3 + improve-check 3。3回目の improve-check が fix-incomplete を返すと escalation で halt） |

## 5. executor 失敗の全件と、その後の再実行（再試行方針の根拠）

codex / claude の `exec.failed` は全期間で **8件**（すべて transient）。

| 日時 | 実行 | 種別 | 同じステップの次の実行 |
| --- | --- | --- | --- |
| 08-25 04:13 | codex implementation | 総上限タイムアウト | **再びタイムアウト**（32分後） |
| 08-25 04:45 | codex implementation | 総上限タイムアウト | 完了（14分後） |
| 08-28 09:05 | codex implementation | 総上限タイムアウト | 完了 |
| 08-31 10:38 | codex implementation | 総上限タイムアウト | 完了 |
| 09-01 07:38 | codex implementation | 総上限タイムアウト | 完了 |
| 09-10 18:18 | claude improve-check | 無進行タイムアウト（idle 900s） | 完了 |
| **09-18 06:01** | codex implementation | **容量不足**: `Selected model is at capacity. Please try a different model.` | **再び容量不足**（13分後） |
| **09-18 06:14** | codex implementation | **容量不足**（同上） | 完了（同じモデル。失敗から約30分後に完了） |

読み取れること:

- **タイムアウトは再実行1回で5/6が回復**した。1件（08-25）は2回目もタイムアウトした
- **容量不足は同じモデルで数十分待てば回復**した。回復の時間尺度は分〜数十分であり、秒ではない
- 容量不足は codex 自身が「別のモデルを試せ」と言っている。**D2 が想定する事象は実在する**（8件中2件）
- ⚠️ 09-10 の idle タイムアウトは、発火が 900s なのに実行の終了まで **17,678 秒**かかっている。
  watchdog のコメントにある「abort は止めてくれの合図でしかない」（SIGTERM から終了まで最大 237s）を
  大きく超える。機械のスリープが疑われる。無人運転の長時間化で表面化しうる（リスクとして記録）

## 6. 中断（Ctrl+C）と transient は、executor の結果からは区別できない

- 両 executor とも、abort されると `failureKind: "transient"` を返す（claude は `interrupted`、codex は `abortedFlag` を経て同じ分類）
- エンジンは watchdog が撃った場合だけ `meta.timeoutKind`（`idle` / `total`）を足す。
  外部からの abort では `firedKind()` が null のまま（「人間が止めた」をタイムアウトと記録しない設計）
- したがって Event Log 上、**人間の Ctrl+C は「transient で timeoutKind なし」になり、容量不足や rate limit と同じ形**

**帰結**: auto は再試行の判断に `failureKind` を使えない。
**auto が自分の AbortController を持ち、「自分が止めた」を自分で知る**（課題D）。

## 7. halt の内訳（課題I の根拠）

全期間の `workflow.halted` は **70件**: validation-failed 36 / invalid-status 34。

invalid-status 34件の型:

| 型 | 件数 | 内訳 |
| --- | ---: | --- |
| `status.step` がステップと不一致 | **20** | task-planning 13 / improve-check 2 / research 2 / implementation 1 / review 1 / reflection 1 |
| result が遷移キーでない | 7 | review `approved` ×2 / `approve` ×2、fix `completed` ×2、research `researched` ×1 |
| nextPhaseId が feature.md に無い | 7 | すべて reflection |

**無人区間内の invalid-status は10件で、すべて 08-27 以前**。どれもそのステップがまだ clipboard だった時期のもの。

| ステップ | executor の導入日 | 導入後の invalid-status |
| --- | --- | --- |
| implementation | 2026-08-19 | 0 |
| improve-check | 2026-09-06 | 0 |
| review | 2026-09-07 | 0 |
| fix | 2026-09-24 | 0 |

## 8. 既存の終了コード

| コード | 意味（cli.ts） |
| --- | --- |
| 0 | 正常 |
| 1 | 運用エラー（exec 失敗・EngineError・未捕捉の例外） |
| 2 | halt（`printOutcome` の halted） |

auto はこれと両立させる（課題G）。

---

# 設計課題

## 課題A: 停止条件の完全な表

### 毎反復の判定順

auto は反復のたびに state.json を読み直し、次の順で判定する。**判定器は1つ**で、`nextSuggestion`・drive と共有する（課題E）。

```text
0. 中断要求（Ctrl+C）が立っている        → A20
1. state.status === "halted"              → A10 / A5-A9
2. pendingApproval                        → A1
3. pendingTransition（チェックポイント）  → resume して継続（停止しない）
4. 終端（complete）                       → A4
5. 未定義のステップ                       → A25
6. executor === "clipboard"               → A2    ┐ ここまでが判定器の外、auto の方針（課題E）
7. auto の区間外（step.auto !== true）    → A3    ┘
8. 予算                                   → A11
9. exec（失敗なら課題D の再試行 → A12-A15）
10. stale status                          → A17   ← **exec の後・run の前にだけ見る**（課題E の訂正）
11. run
```

### 表

**正常停止（人間の番）— 終了コード 0**

| # | 条件 | 検出 | 表示する1行 | 再開方法 |
| --- | --- | --- | --- | --- |
| A1 | 承認ゲート到達 | `state.pendingApproval`（run の結果 `awaiting-approval`、または起動時に既に承認待ち） | `⏸ 承認待ち: review — aiw approve / aiw reject <理由>` ＋ 判断材料（`formatBriefing`） | 人が approve → `aiw auto` で続きから。reject（rerun）なら同じステップを auto が再実行（区間内のとき） |
| A2 | clipboard ステップ到達 | `step.executor === "clipboard"`（task-planning / reflection / review-audit） | `⏸ 人の番: reflection は clipboard — aiw drive か aiw prompt reflection` | 人が実行して run → 次のゲート承認後に `aiw auto` |
| A3 | **区間外の executor ステップ到達** | `step.auto !== true`（現行では research） | `⏸ auto の対象外: research（executor: claude）— aiw drive / aiw exec research` | 同上 |

**区間の宣言（2026-09-25 決定）**: `auto: true` を付けるのは **implementation / review / fix / improve-check の4つだけ**。
**research には最初は付けない**（段階制）。research は `ux-decision-required` で自分に戻る唯一のステップで、
無人で回すと「AI が UX 判断を保留したまま research を再走し続ける」経路が理論上ある。
まず4ステップの区間で auto の停止挙動を実測し、research の組み入れはその後に判断する（BL-240）。

補足（判断を覆すものではなく、組み入れを判断するときの材料）: 現行の設定では research はゲート②を持つので、
`ux-decision-required` でも毎回承認待ち（A1）で止まり、周回ごとに人の承認が挟まる。
ゲートを外した research に `auto: true` を付けた場合は、課題H の構造検査が
「retryPolicy を通らない循環 research → research」として起動を拒否する（A24）。
| A4 | 完了 | currentStep が終端 | `✅ 完了 — aiw new-task` | 新しいタスクを人が始める。auto は reflection で止まるので、通常は起動時にしか到達しない |

**halt — 終了コード 2（既存の run と同じ意味）。auto は resume しない**

| # | 条件 | 検出 | 表示する1行 | 再開方法 |
| --- | --- | --- | --- | --- |
| A5 | escalation | run の結果 `halted` / `escalation` | `⛔ HALT(escalation) improve-check→fix: 再試行上限 3 を超過 — 人の判断が要る` | 人が対処 → `aiw resume` → `aiw auto` |
| A6 | invalid-status | 同 `invalid-status`（step 不一致 / result が遷移キーでない / nextPhaseId） | `⛔ HALT(invalid-status) review: result "approved" は遷移キーでない（許可: ready \| fix-required）` | 同上 |
| A7 | validation-failed | 同 `validation-failed`。file-exists / json-schema / artifact-contract / **token-range** / diff-scope（fix の halt 宣言）/ status ファイル不在 | `⛔ HALT(validation-failed) fix: diff-scope — 7 file(s) outside the declaration` | 同上 |
| A8 | post-action-failed | 同 `post-action-failed` | `⛔ HALT(post-action-failed) reflection: archiveFeature — <理由>` | 同上（区間内では通常到達しない） |
| A9 | approval-rejected | 同 `approval-rejected` | `⛔ HALT(approval-rejected) …` | **現行設定では到達しない**（全ゲートが onReject: rerun）。型に存在するので表に載せる |
| A10 | 起動時に既に halt | `state.status === "halted"` | `⛔ 既に HALT(<理由>) — auto は resume しない。直してから aiw resume` | 同上 |

指示文の語彙との対応: `clarification-required` → 存在しない（行なし）/
`ux-decision-required` → research の承認待ち（ゲート②）で A1、承認後は research へ戻るので A3 /
`token-range` → A7。

**予算 — 終了コード 3**

| # | 条件 | 検出 | 表示する1行 | 再開方法 |
| --- | --- | --- | --- | --- |
| A11 | 予算超過 | 次のステップ実行の前に「この起動での実行回数 ≥ 予算」 | `⛔ 予算超過: 8/8 — モデル化されていない経路（workflow.yaml と Event Log を確認）` | 人が原因を確認 → `aiw auto`（予算は起動ごと） |

**executor 失敗 — 終了コード 4（state は変わらない）**

| # | 条件 | 検出 | 方針 | 表示する1行（停止時） | 再開方法 |
| --- | --- | --- | --- | --- | --- |
| A12 | permanent | `failureKind: "permanent"` | 再試行しない | `⛔ executor 失敗(permanent) implementation: <理由>` | 人が直す → `aiw auto`（fresh 再実行） |
| A13a | 総上限タイムアウト | `meta.timeoutKind === "total"` | **1回だけ即再試行** | `⛔ executor 失敗(total-timeout ×2) implementation` | 同上 |
| A13b | 無進行タイムアウト | `meta.timeoutKind === "idle"` | **5分待って1回だけ再試行** | `⛔ executor 失敗(idle-timeout ×2) improve-check` | 同上 |
| A14 | その他の transient | transient・timeoutKind なし・auto 自身の中断でない | **3回、5分 / 15分 / 30分待って再試行**（→ D2 が入れば fallback） | `⛔ executor 失敗(transient ×4) implementation: Selected model is at capacity…` | 同上 |
| A15 | 組み立て失敗 | exec が `PromptAssemblyError` を投げた | 再試行しない（宣言のファイルが無い＝設定の問題） | `⛔ executor 失敗(assembly) review: skills/review/SKILL.md が無い` | 同上 |

**無進行 — 終了コード 5（engine.ts の M4 申し送りの実装）**

| # | 条件 | 検出 | 表示する1行 | 再開方法 |
| --- | --- | --- | --- | --- |
| A17 | stale status | run 前検査の EngineError（current-status.json が前のステップの宣言のまま） | `⛔ 無進行: current-status.json が前ステップ "review" の宣言のまま — executor が status を書かなかった` | 人が成果物を確認 → `aiw auto` |
| A18 | 反復で state が進まない | 反復の前後で state の指紋（currentStep / status / fixAttempts / pendingApproval / pendingTransition / lastCompletedStep）が同一で、上のどの停止にも当たらない | `⛔ 無進行: review の反復で状態が変わらなかった` | 同上 |
| A19 | 起動中に state が外から変わった | exec / run の前提検査（`assertStepRunnable`）の EngineError | `⛔ 無進行: state が起動中に変わった（別の aiw が動いている？）` | 同上 |

⚠️ A17 は engine.ts の `staleStatusStep` に M4 時点で書かれていた申し送り
（「state を進めずに終わったエラーを再試行すると無限に回る。auto はこれを独自の停止条件にせよ」）そのもの。

**中断 — 終了コード 130（シェルの慣習 128 + SIGINT）**

| # | 条件 | 動作 | 表示する1行 | 再開方法 |
| --- | --- | --- | --- | --- |
| A20 | Ctrl+C（exec 中・待機中） | auto の AbortController を abort し、executor の終了を待つ。**再試行しない**。待機中なら待機を打ち切る | `⏹ 中断: implementation（state は変更なし。aiw auto で fresh 再実行）` | `aiw auto`（同じステップを fresh で） |
| A21 | Ctrl+C 2回目 | 即時終了 | `⏹ 強制終了: 子プロセスが残っている可能性 — Get-Process codex,claude で確認` | 子プロセスを確認 → `aiw auto` |
| A22 | Ctrl+C（run 中） | run は同期処理で割り込めない。**完了を待ってから**止まる（postActions の途中で止めない） | A20 と同じ | 同上 |

**起動拒否 — 終了コード 1（既存の運用エラーと同じ意味）**

| # | 条件 | 表示する1行 |
| --- | --- | --- |
| A23 | 同時実行（ロック取得失敗） | `✖ 別の aiw auto が実行中（pid N, 開始 HH:MM）` |
| A24 | 区間の構造検査に失敗（課題H） | `✖ auto の区間に retryPolicy を通らない循環がある: a → b → a` |
| A25 | 未定義のステップ / 設定のロード失敗 / 想定外の例外 | 既存の `error: …` |

**停止しない（継続する）もの — 明示しておく**

| 事象 | 扱い | 理由 |
| --- | --- | --- |
| 区間内の次ステップへの遷移 | 継続 | 通常の進行 |
| `report` 宣言の違反（implementation の diff-scope / verify-local / consumer-presence など） | **継続**。表示と停止サマリには出す | 停止へ格上げすると判定の変更になる（前提5） |
| pendingTransition（チェックポイント） | resume して継続 | drive と同じ。postActions の冪等性は既存テストが保証 |
| transient の再試行中 | 継続（A13 / A14 の上限まで） | — |
| exec が `ok: true` だが成果物が無い | run へ進み、validator が捕まえる（A7） | 「exit 0 は作業をしたことを意味しない」（M3 C-3 / M4 §9-2）。成否は validator が決める |

## 課題B: 再開の冪等性

**原則: auto は永続する状態を持たない。** 毎反復で state.json を読み直し、
起動中だけのカウンタ（予算・再試行回数）はメモリに置く。再起動でゼロに戻るのは意図どおり
（再起動は人間の判断であり、そこで予算を仕切り直す）。

| auto が死んだ時点 | state.json | 再起動したときの動き |
| --- | --- | --- |
| exec 中 | 変わらない（exec は state を書かない・不変条件1） | 同じステップを **fresh で再実行**。成果物は上書きされる。M3 / M4 の防衛線1（kill → 成果物だけから fresh 再実行で完走）と同じ経路 |
| exec 完了〜run 前 | 変わらない | **もう一度 exec する**（無駄は1回分） |
| run 中（validator〜commit） | `writeState` は tmp + rename で原子的。postActions の前なら未変更 | 未変更ならやり直し。postActions の途中なら `pendingTransition` → resume（既存の冪等性。test 7 / 7b / 27b） |
| 再試行の待機中 | 変わらない | 待機は捨てて、すぐ exec する（容量不足が続いていれば再び待機に入る） |
| ゲートで停止した後 | 承認待ち | 人が approve → `aiw auto` |

「exec 完了〜run 前」で、Event Log の `exec.completed` を見て run へ飛ぶ最適化は**しない**。
それをすると auto が **Event Log を状態として読む**ことになり、
「state.json だけから続く」という保証が崩れる。無駄は最大で executor 起動1回分。

### 同時実行のロック

2つの auto（または auto と手動の exec）が同じステップを同時に走らせると、同じ成果物を奪い合う。

- `runs/auto.lock` に `{ pid, startedAt, runId }` を置く。取れなければ A23 で起動拒否
- pid が既に存在しなければ古いロックとみなして引き継ぎ、そう表示する
- ロックは**相互排他のためのもの**で、進行の記録ではない。auto の進行はあくまで state.json から導く

⚠️ drive や手動の `aiw exec` はロックを見ない（既存の挙動を変えない）。
auto の実行中に人が手で state を動かした場合は、A19 で検出して止まる。

## 課題C: 予算の既定値

**単位**: 1回の起動における**ステップ実行回数**（exec → run の1サイクルを1と数える。
同じ起動の中の再試行は数えない。再試行には別の上限がある・課題D）。

**既定値は workflow.yaml から導出する**:

```text
予算 = Σ（区間内のステップ）  retryPolicy を持つステップを含む循環の上にある → maxRetries + 1
                              それ以外                                    → 1
     = implementation 1 + review 1 + fix 3 + improve-check 3 = 8
```

起動時に内訳を表示する（`予算 8 = implementation 1 + review 1 + fix 3 + improve-check 3`）。
上書きは `--max-steps N` と `settings.autoMaxSteps`（CLI が優先）。

**「正常な経路では当たらない値」にするのが設計意図。**

- 1回の起動での最大は 6（調査結果 §4 の区間③→）。予算 8 との差 2 が余裕になる
- 実測の全期間最大 8 / 09-04 以降の最大 4 とも整合する
- 正常な経路で当たる予算は、escalation と並ぶ**第2の判定**になり、前提5 に反する。
  予算が発火したら、それは「ワークフローのモデル化から外れた経路を通った」ことを意味する

## 課題D: transient の再試行

**判定に使う材料**（executor を変えずに手に入るもの）:

| 材料 | 出どころ |
| --- | --- |
| `failureKind`（transient / permanent） | executor |
| `meta.timeoutKind`（idle / total） | エンジン（watchdog） |
| **auto 自身が中断したか** | **auto の AbortController**（調査結果 §6: 結果からは区別できない） |

**方針**:

| 事象 | 再試行 | 間隔 | 根拠 |
| --- | --- | --- | --- |
| auto 自身の中断（Ctrl+C） | しない | — | 人間の意思 |
| permanent | しない | — | 再試行しても同じ |
| 総上限タイムアウト（`timeoutKind: total`） | **1回** | **即時** | 1回で 5/6 が回復（§5）。重いタスクの揺らぎであり、待っても変わらない。1回あたり最大で総上限（30〜40分）+ kill の遅れがかかるので2回目は人に返す |
| 無進行タイムアウト（`timeoutKind: idle`） | **1回** | **5分待つ** | 止まった原因（BL-054 型の webServer のハングなど）が残ったまま即座に同じ壁へ再突入する可能性が高い。即時だと1回を無駄にする |
| その他の transient（容量不足・rate limit・ネットワーク・不明） | **3回** | **5分 → 15分 → 30分** | 容量不足は同じモデルで数十分待つと回復した（§5）。累計 50 分待つ |

⚠️ **total と idle を分けた設計（M4 の watchdog。エンジンが理由文字列と `timeoutKind` を書き分ける）が、
ここで初めて挙動の分岐に使われる**（2026-09-25 承認時の修正）。
それまで2つは記録と表示を分けるだけだった。auto の実装はこの分岐を `timeoutKind` の値で行い、
理由文字列を解析しない。

- 待機は Ctrl+C で打ち切れる（A20）
- 再試行は同じ `execStep` 呼び出しをもう一度行う（exec は冪等・不変条件3）
- 1回の起動での再試行の総数に上限を置く: **6回**（予算 8 × 再試行 3 の最悪値を無人で払わせない）
- 設定: `settings.autoRetry: { totalTimeout: 1, idleTimeout: 1, idleWaitMs: 300000, transient: 3, transientWaitsMs: [300000, 900000, 1800000], maxPerRun: 6 }`。
  値は `auto.started` イベントに記録する

**記録**: `auto.retry` イベント `{ runId, step, attempt, cause: "total-timeout" | "idle-timeout" | "transient", waitMs, message }`。
message は `redactSession` を通して先頭 200 字（生 session ID を載せない・不変条件6）。
失敗そのものの詳細は既存の `exec.failed` にある。

## 課題D2: モデルフォールバック

### 切り替えの仕組みは executor を変えずに作れる

executor はモデルを config から読む（codex: `settings.codexModel` / claude: `step.model ?? settings.claudeModel`）。
**auto がモデルだけ差し替えた config の写しを `execStep` に渡せば**、executor はそのモデルで起動する。
記録も既存どおり executor が `meta.modelRequested`（claude は `modelObserved` も）に残す。

### ⚠️ 発動の判定は、executor の変更なしには正しく作れない

発動条件は「rate limit / 混雑系の transient のみ。timeout は含めない」。
しかし executor の返り値は **transient / permanent の二値**で、容量不足（§5 の2件）も
ネットワークエラーも「理由の分からない失敗」も、すべて同じ transient になる。
timeout だけは `timeoutKind` で除外できるが、**残りの transient から容量不足と rate limit だけを取り出す欄が無い**。

選択肢:

| 案 | 内容 | 問題 |
| --- | --- | --- |
| (a) executor に `transientCause` を足す（`capacity` / `rate-limit` / `network` / `unknown`） | 生のイベント（claude の `api_error_status` 429 / 529、codex のエラー本文）を見た場所で分類する | **M5 のやらないこと「executor の変更」に当たる** |
| (b) auto が `result.error` の文字列を正規表現で分類する | executor を変えない | 分類が3箇所目になる（claude の `classifyFailure`・codex の permanent 判定・auto）。KI-01 型のずれの温床 |
| (c) エンジンが `classifyTimeout` の隣で文字列から分類する | executor を変えない | (b) と同じ問題が2箇所で起きる |

**決定: D2 は M5 本体から切り離し、(a) の小枠の後に入れる**（2026-09-25 承認）。
(a) の `transientCause` の小枠は BL-221 と同種の executor 整備なので、**M5 の実装と並行して先に入れてよい**（BL-238）。

- 分類は生のイベントを見た場所に置くのが筋（BL-221 と同型の「意味を揃える」小枠）
- 実測の発生は 141 タスクで2件、同じモデルで数十分待つと回復した。**D の待機つき再試行で当面は回る**
- フォールバックはタスクの途中でモデルを変え、M4 で pin した比較可能性を崩す。記録の仕組み（下記）と同時に入れるべき

### 仕様（後続枠で実装する）

| 項目 | 仕様 |
| --- | --- |
| 設定 | `settings.codexModelFallbacks` / `settings.claudeModelFallbacks`（順序付きリスト・既定は空）。**実装するまでキーを足さない**（読まれない宣言を作らない・KI-09） |
| 発動 | 同じモデルでの transient 再試行（課題D）を使い切り、かつ `transientCause` が `capacity` / `rate-limit` のとき |
| 除外 | timeout・permanent・auto 自身の中断・`network` / `unknown` の transient |
| 順序 | リストの先頭から1つずつ、**各1回**だけ即時に試す。容量不足なら次へ。timeout になったら止める（モデルを替える理由にならない） |
| 範囲 | **起動1回の中だけ**（sticky にしない）。次のステップは pin したモデルから始める（2026-09-25 承認: 混雑は一時的、pin が正、の関係を保つ最小の形） |
| 使い切り | **auto の停止**（終了コード 4・state は変わらない） |
| claude のステップ上書き | `step.model` があればそれを起点に、`claudeModelFallbacks` を後ろに試す |

⚠️ **指示文の「全段使い切りで halt」は、auto の停止（終了コード 4）と読み替える**（2026-09-25 承認）。
エンジンの halt は state.json の書き換え（`status: "halted"`）であり、run の検証経路だけが行う。
exec の失敗は state を変えない（不変条件1）。auto が halt を書けるようにすると、
exec 側に state を変える力を持たせることになる。有界の思想は「上限で必ず止まる」で満たせる。

### 必ず大きな音を立てる

pin の「黙って変わらない」を、フォールバックでは「変わったら必ず聞こえる」に置き換える。

| 場所 | 出すもの |
| --- | --- |
| Event Log | `auto.fallback { runId, step, pinnedModel, modelUsed, fallbackReason, attemptsOnPinned }`。exec 側の `meta.modelRequested` にはフォールバック先が入る |
| 進行表示 | `⚠ implementation: gpt-5.6-sol が容量不足 → gpt-5.6-terra で実行（フォールバック）` |
| 停止サマリ | 実行表の model 欄に `sol → terra（fallback: capacity）` |
| `aiw status --summary` | Observed 側に `Model fallback: implementation (gpt-5.6-sol → gpt-5.6-terra, capacity)` |
| baseline 集計 | フォールバックを含むタスクに印を付け、モデルを pin した世代の集計と**分けて**数える |
| review-audit | review がフォールバックで実行されたら、M4 課題G の model-change トリガーが発火する（前回の review と `modelRequested` が違うため）。これは意図どおりとする |

## 課題E: drive との関係 ← **別コマンド・同じループ**

**提案**: 判定器を1つにし、drive と auto はその上の**方針（policy）**の違いにする。

```text
engine: classifySituation(root, config) → Situation      ← nextSuggestion / drive / auto が共有
          | halted | awaiting-approval | checkpoint | terminal | unknown | runnable(step)

cli:    stepLoop(policy)
          drive policy: ゲートで y/n を聞く / halt で resume を聞く / 実行前に y/n を聞く
          auto  policy: ゲート・halt で止まる / runnable でも clipboard・区間外なら止まる / 実行は確認なし
```

### 判定の優先順位（宣言・2026-09-25 承認時の注文で固定）

複数の条件が同時に成り立つとき、**どれを人間に見せるか**の順序。判定器の中の if の並びで暗黙に決まってしまう類の仕様なので、ここに1列で宣言し、テストで固定する。

| 優先 | 状況 | 条件 |
| ---: | --- | --- |
| 1 | `halted` | `state.status === "halted"` |
| 2 | `awaiting-approval` | `state.pendingApproval` がある |
| 3 | `checkpoint` | `state.pendingTransition` がある |
| 4 | `terminal` | currentStep がどのステップにも定義されておらず、どこかの遷移先として現れる（config から導出） |
| 5 | `unknown` | currentStep がどのステップにも定義されておらず、遷移先にも現れない |
| 6 | `runnable` | 上のどれでもない（currentStep が定義済み） |

- **判定器の存在意義は「順序が1箇所に書かれ、テストで固定されている」こと**。
  条件を足すとき（auto の停止条件が増えるときなど）は、この表に行を足し、テストの表にも同じ行を足す。
  表とテストのどちらかだけを変えない
- テスト: 2つ以上の条件を同時に立てた state を組み合わせで作り、勝つ状況がこの表の順になることを確かめる
  （表の上位の条件を1つ立てれば、それより下の条件がいくつ立っていても上位が勝つ）
- 判定器の外にある auto の方針（clipboard・区間外・予算）と、exec の後の stale の検査は、
  この表の `runnable` の中での扱いであり、優先順位の表には入れない

**判定器は state だけで決まる状況しか返さない。** clipboard か・区間内か は
「runnable なステップをどう扱うか」という方針の側（auto だけの概念）に置き、
stale status は exec の後の検査に置く（下記）。

### ⚠️ 初版の誤り: stale status を判定器に入れていた

ドラフト（`f9ef065`）は判定器の状況に `stale-status` を入れていた。**そのまま実装すると auto は全ステップの手前で止まる。**

遷移の確定（`commitTransition`）で `lastCompletedStep` に遷移元が入り、
current-status.json は遷移元が書いた宣言のまま残る（claude のステップでも、既にファイルがあるので
0 バイトスタブは作られない）。したがって `staleStatusStep` は
**遷移の直後、次のステップの exec の前という普通の状態で、毎回「stale」を返す**。
engine.ts の `execStep` のコメントにあるとおり、exec の前に前ステップの宣言が残っているのは正常であり、
stale の検査が意味を持つのは **exec の後・run の前**だけ。

- auto: exec の後に検査し、当たれば A17（無進行・終了コード 5）
- next: 今の提案文（「current-status.json を作り直してから run」）はそのまま残す。
  runnable の提案文を細かくするためだけに使い、状況の分類には使わない
- 故障注入 #24 に「遷移直後の普通の状態で auto が止まらないこと」を足した（この誤りの再発防止）

### 独立コミットにする（2026-09-25 承認時の注文）

判定器の抽出と drive / next の載せ替えは、**auto 本体とは別のコミット**にする。

1. 載せ替えの前に、到達しうる全状態に対する drive と next の判定をテストで固定する（故障注入 #22）
2. 判定器を抽出して載せ替える
3. 固定したテストが通ることを確かめる。**統一で挙動が変わった点は完了報告で列挙する**
4. その後で auto を載せる

判定の順序のずれを直す作業は、直した瞬間に drive の挙動が微妙に変わりうる（今のずれに依存した運用がありうる）。

### 統一で変わりうる点（設計時点の洗い出し）

コードを突き合わせて、drive と next の判定が食い違う状態を列挙した。実装はこの表を出発点に、
見落としを足して完了報告で確定させる。

| # | 状態 | 今の drive | 今の next | 統一後（next の順） | 到達しうるか |
| --- | --- | --- | --- | --- | --- |
| 1 | currentStep が未定義 **かつ** halted / 承認待ち / チェックポイントのどれか | 「不明なステップ」と表示して終了 | halted なら resume、承認待ちなら approve を提案 | **drive も halted / 承認待ち / チェックポイントを先に扱う** | エンジンの遷移だけでは到達しない（halt は定義済みのステップで起き、commit はチェックポイントを消す）。**workflow.yaml を編集してステップ名を変えた**ときに起きる |
| 2 | 終端の判定 | 文字列 `"complete"` と比べる | config から導く（どのステップにも定義が無く、遷移先として現れる ID） | **config から導く** | 現行の終端は `complete` だけなので差は出ない。終端の名前を変えたときだけ drive の挙動が変わる（改善の方向） |
| 3 | stale status | 検査しない（run が EngineError を投げ、drive は表示して同じ状態で再び聞く） | 提案文を「status を作り直してから run」に変える | **両方とも今のまま**（判定器には入れない。上記） | 遷移直後に毎回成立する |
| 4 | runnable の扱い | executor 宣言があれば y/n、なければ clipboard | `aiw run <step>` を提案 | **変えない**（方針の側の違いとして残す） | — |

表の1と2以外で drive の挙動が変わる点は、設計時点では見つかっていない。

**表の2には実証のテストを1本付ける**（2026-09-25 承認時の注文）。今は終端が `complete` だけなので差は出ないが、
config からの導出に変える意味は「終端が増えても drive が壊れない」ことにある。
テスト用の workflow で終端を2つにし（例: review-audit の遷移先を `complete` 以外の名前に変える）、
**drive と next が両方の終端で正しく終わる**ことを固定する。導出化を宣言ではなく実証にする。

| 観点 | 判断 |
| --- | --- |
| コマンド | **`aiw auto` を別コマンド**にする。drive は対話（stdin を読む）、auto は無対話で終了コードを返す。同じコマンドのモードにすると、スクリプトから呼んだときに stdin 待ちで止まる経路が残る |
| 共有するもの | 判定器・exec → run の1サイクル・進行表示（`progressPrinter`）・結果表示（`printOutcome` / `printExecResult`）・ゲートの判断材料（`buildBriefing`） |
| 共有しないもの | 各分岐での決定（方針）だけ |
| 判定の順序 | `nextSuggestion` の順（halted → 承認 → チェックポイント → 終端 → 不明 → runnable）に揃える。drive の挙動が変わるのは上の表の1と2だけ（どちらもエンジンの遷移だけでは到達しない）。テストで固定してから載せ替える |
| next | `nextSuggestion` も判定器の上に載せ替える。「predicate が2箇所にあったことが順序のずれを許した」の再発を構造的に止める |

## 課題F: 表示

### 実行中

```text
aiw auto — 予算 8 = implementation 1 + review 1 + fix 3 + improve-check 3 / 再試行 timeout 1・transient 3
▶ [1/8] implementation  (codex · gpt-5.6-sol)
[12:03:15] edit: BudgetGrid.tsx                     ← 既存の progressPrinter
[12:09:42] tokens: in 1.2M / out 18K
✓ implementation → review  (6m27s)   ⚠ report: verify-local — typecheck failed (2 errors)
▶ [2/8] review  (claude · claude-opus-5 · effort high)
…
↻ implementation: transient — 15分後に再試行 (2/3)   Ctrl+C で中断
```

- `--quiet`: 進行の1行（`progressPrinter`）を抑え、ステップの見出しと停止の1行だけを出す
  （M3 課題I の要求5「quiet で抑制できる。M5 の auto ではステップ単位の要約だけが欲しい」）
- 生 session ID を出さない（既存の `progressPrinter` と同じ規律。故障注入 #20）

### 停止時のサマリ

| 順 | 内容 | 出どころ |
| --- | --- | --- |
| 1 | 停止理由の1行（課題A の表） | auto |
| 2 | この起動の実行表: step / executor / model（requested → observed）/ 所要 / 結果 / 再試行 / fallback | **Event Log の `auto.*` と `exec.*`**（auto はメモリにしか持たないので、Event Log を正とする） |
| 3 | トークン（**executor 別。合算しない**・前提1） | `exec.completed` |
| 4 | `status --summary`（Claimed / Observed） | **再利用**（`buildSummary` / `buildObserved`） |
| 5 | ゲートで止まったときは判断材料 | **再利用**（`buildBriefing` / `formatBriefing`） |
| 6 | 次の一手 | **再利用**（`nextSuggestion`） |

計画 M5.4 の項目のうち、既存の `status --summary` に無いもの（通過ステップ・停止理由・所要時間・
executor / model・再試行・フォールバック）は 2 で埋める。session は fresh 固定なので「fresh」と定数で出す。

**`aiw status --summary` にも直近の auto 起動を載せる**（Observed 側。現在のタスクの窓に `auto.stopped` があるとき）。
後から来た人間が「auto がどこまで何をして、なぜ止まったか」を同じ画面で読めるように。

### 機械向け

`aiw auto --json` は最後に1行の JSON を出す:
`{ "stop": "gate" | "clipboard" | "out-of-zone" | "complete" | "halted" | "budget" | "exec-failed" | "no-progress" | "interrupted" | "refused", "step", "reason", "exitCode", "executed": [...] }`

## 課題G: 終了コード

| コード | 意味 | 該当行 |
| --- | --- | --- |
| **0** | **人間の番**（ゲート到達 / clipboard / 区間外 / 完了） | A1-A4 |
| 1 | 起動拒否・想定外のエラー（既存の意味と同じ） | A23-A25 |
| **2** | **halt**（既存の run と同じ意味） | A5-A10 |
| 3 | 予算超過 | A11 |
| 4 | executor 失敗で停止（再試行を使い切った / permanent / 組み立て失敗） | A12-A15 |
| 5 | 無進行 | A17-A19 |
| 130 | Ctrl+C | A20-A22 |

- **0 は「異常なし、あなたの番」**で統一する。ゲートか clipboard かはスクリプトから見れば同じ「人の番」であり、
  区別したいときは `--json` の `stop` を読む
- 既存の 1 / 2 の意味は変えない（run・exec と同じ解釈でスクリプトを書ける）

```bash
aiw auto --quiet; case $? in 0) echo "あなたの番";; 2) echo "halt";; 130) echo "中断";; *) echo "異常停止 $?";; esac
```

## 課題H: 安全弁（無限ループの構造的防止）

### 区間内の循環を列挙する

区間（implementation / review / fix / improve-check）の遷移で、auto が1回の起動の中でたどりうる辺:

| 辺 | 起動内でたどるか |
| --- | --- |
| implementation → review | たどる |
| review → fix / reflection | **たどらない**（review はゲート③を持ち、run の結果は必ず承認待ち＝A1 で止まる） |
| fix → improve-check | たどる |
| improve-check → fix | たどる（**唯一の循環**。fix の retryPolicy が有界にする） |
| improve-check → reflection | 区間の外へ出る（A2） |

区間の外の循環（research → research、reflection → task-planning）は、区間の宣言（A3）と clipboard（A2）で入口が閉じている。

### 入れる弁 / 入れない弁

| 弁 | 判断 | 理由 |
| --- | --- | --- |
| **起動時の構造検査** | **入れる** | 区間の部分グラフ（ゲートを持つステップから出る辺を除く）の循環を列挙し、**すべての循環が retryPolicy を持つステップを通ること**を確かめる。通らなければ A24 で起動拒否。将来 workflow.yaml に循環が足されたとき、走らせる前に止まる |
| **無進行の弁**（A17-A19） | **入れる** | 反復のたびに「state が進んだか、停止条件に当たったか、再試行か」のどれかであることを要求する。stale status など **state を進めずに終わる経路**を、種類を問わず捕まえる |
| 予算（課題C） | 入れる | 上の2つの分析が間違っていたときの最後の網 |
| **同じステップの再実行回数の上限（N 回）** | **入れない** | 区間内で同じステップを繰り返す唯一の経路は fix ⇄ improve-check で、fixAttempts（初回 + 2）が既に有界にしている。auto が別の回数を数えると**第2の fixAttempts**になり、判定に関与することになる（前提5）。構造検査がこの前提を起動のたびに確かめる |

## 課題I: status 宣言の機械導出

### ステップごとの result の性質

| ステップ | result の語彙 | 性質 | 機械導出 |
| --- | --- | --- | --- |
| task-planning | planned | 単一 | 可（区間外） |
| research | research-complete / **ux-decision-required** | 既定 + 自己申告 | 既定だけ可。ux-decision-required は申告が優先 |
| implementation | implemented | 単一 | 可 |
| **review** | **ready / fix-required** | **判断**（二値） | **不可** |
| fix | fixed | 単一 | 可 |
| **improve-check** | **ready-for-reflection / fix-incomplete** | **判断**（Critical が解消されたか） | **不可** |
| reflection | feature-continue（+ nextPhaseId）/ feature-complete | 判断 + データ | 不可 |
| review-audit | audit-complete | 単一 | 可（区間外） |

⚠️ **指示文の前提の訂正**: 「complete 系」の例に挙がった `review-approved` という結果は存在せず（実在は `ready`）、
**`fix-required` は review の判断そのもの**である。validator の結果と成果物の存在からは決まらない。
current-review.md の Fix Scope の中身から導くことは技術的には可能だが、それは
**契約の意味の解釈をエンジンへ移す**ことであり、契約の変更にあたる（M5 のやらないこと）。
機械導出できるのは**単一結果のステップ**（implementation / fix / task-planning / review-audit）と、
**research の既定値**に限られる。

### 期待できる効果（実測・調査結果 §7）

| 対象 | invalid-status | 導出で消えるか |
| --- | ---: | --- |
| **auto の区間（executor 化の後）** | **0** | 消すものが無い |
| 区間の clipboard 時代（〜08-27） | 10 | 既に executor 化で消えている |
| task-planning（step 不一致） | 13 | 09-04 に前タスクの status を削除するよう変えて以降、同じ事象は `validation-failed`（status 不在）へ移った |
| research（`researched`） | 1 | 既定の導出で消える |
| reflection（nextPhaseId） | 7 | 消えない（判断 + データ） |

**auto に対する効果は、観測上ゼロ**。区間の invalid-status は executor と Skill の整備で既に消えている。

### リスク

1. **`status.step` は「この宣言は今のステップのために書かれた」という鮮度の証明も兼ねている**。
   2026-09-04 の事故（前タスクの status がたまたま `"step": "task-planning"` だったので検査を素通りし、
   古い計画が承認ゲートまで進んだ）がそれを示す。導出に移るなら、鮮度の証明を別の仕組み
   （例: 遷移の確定時にエンジンが status ファイルを消す）で置き換える必要がある
2. **明示の完了申告を外すと、BL-213 の穴が静かな素通りになる**。research-findings.md のテンプレートは
   必須の見出しを全部持つので、research が何も書かなくても artifact-contract を通る。
   今は AI が `research-complete` を明示しない限り進まないが、導出にすると**何も書かなかった research が完了扱いになる**
3. **status スキーマ（result を任意にする）と、status ファイルの file-exists 宣言の変更が要る**。
   どちらも契約・validator の変更で、M5 のやらないことに当たる

### 再解釈（設計文書に残す）

M0 の原則「AI が宣言し、エンジンが検証する」の価値は、主に**判断を含む自己申告**
（ux-decision-required のような「進めない」という申告と、review / improve-check の判断）にあった。
単一結果のステップでの宣言は、判断ではなく**儀式**であり、invalid-status の多くはその儀式の書き損じだった。

ただし儀式には副作用として**鮮度の証明**という役割があった（リスク1）。
導出に移るなら、儀式を消すだけでなく、この役割の代わりを用意しなければならない。

### 見積もりと推奨

| 作業 | 規模 |
| --- | --- |
| completion.ts: 単一結果の導出・research の既定値・申告の優先 | 中 |
| 鮮度の証明の置き換え（遷移確定時に status を消す）と、それに伴う file-exists 宣言の見直し | 中（契約・validator の変更） |
| status スキーマ（result を任意に）+ 後方互換（書いても無害）のテスト | 小 |
| Skill 7本の文言（書かなくてよい / 申告だけ書く） | 小 |
| 前提条件: **BL-213** の解消 | 別枠 |
| 世代注記（AI に書かせるものが変わる） | 小 |

**決定: M5 には入れない。後続枠にする**（2026-09-25 承認・BL-239）。

- 効果は auto の区間で観測上ゼロ、リスクは実在する（鮮度の証明の喪失・BL-213 の素通り化）
- 契約と validator の変更を含み、M5 のやらないことに当たる
- 着手条件: **BL-213 が解消済み**、かつ M5 の運用で区間内に invalid-status が再び出る
  （あるいは research の語彙の書き損じが再発する）こと

**後続枠の設計条件**（2026-09-25 承認時に追加）:
**機械導出に移っても、`status.step` が担っていた「この宣言は今のステップのために書かれた」という鮮度の証明を失わないこと。**
09-04 の事故（前タスクの status が一致検査を素通りし、古い計画が承認ゲートまで進んだ）が実例。
儀式を消すなら、この役割の代わりを同じ変更の中で用意する。

⚠️ BL-213 は旧番号 BL-116（2026-09-17 の振り直し）。ドラフト（`f9ef065`）は旧番号で書いていたので、
アプリ側の別件 BL-116（resolved）と取り違えうる状態だった。本文はすべて BL-213 に直した。

## 課題J: 世代管理

- auto の運用開始を `docs/baseline.md` に記録する（最初に auto で区間を走らせたタスクの日付と、どちらの区間か）
- **auto は判定に関与しないので、Fix 率・validator の結果の世代は切り替えない**。
  変わりうるのは「所要時間」（人間の待ち時間が消える）と「再試行の有無」だけ。
  所要時間を M4 世代と比べるときは auto の有無を注記する
- D2 を入れたら、フォールバックを含むタスクを別に数える（課題D2）

---

# 故障注入（実装の完了条件）

| # | 注入 | 期待 |
| --- | --- | --- |
| 1 | exec 中に kill → `aiw auto` を再起動 | 同じステップを fresh で再実行して完走（課題B） |
| 2 | run の postActions の途中で kill → `aiw auto` | チェックポイントから resume して完走 |
| 3 | exec 中に Ctrl+C | 再試行しない・130・state は変わらない |
| 4 | 再試行の待機中に Ctrl+C | 待機を打ち切る・130 |
| 5 | abort 済みの signal で起動（codex / claude の両方） | executor が起動しない（Test 173 の延長） |
| 6 | permanent | 再試行しない・4 |
| 7 | 総上限タイムアウト → 再試行も総上限タイムアウト | 即時に1回だけ再試行して 4 |
| 8 | transient が続く（待機は注入で短縮） | 3回再試行して 4。`auto.retry` が3件 |
| 9 | **stale status**（executor が status を書かない） | 5。**無限に回らない**（engine.ts の申し送りの固定点） |
| 10 | 反復で state が進まない（run の結果を注入） | 5 |
| 11 | 予算 1 で起動 | 2本目の前で 3 |
| 12 | currentStep = research（区間外） | 0・research を実行しない |
| 13 | currentStep = reflection（clipboard） | 0・何も実行しない |
| 14 | halt 各種（escalation / invalid-status / validation-failed） | 2・resume しない・state は変わらない |
| 15 | 起動時に既に halt | 2・何も実行しない |
| 16 | retryPolicy を通らない循環を区間へ注入 | 起動拒否・1 |
| 17 | 同時起動 | 2つ目が 1 で拒否。古いロック（pid が無い）は引き継ぐ |
| 18 | report 違反（verify-local の失敗） | **継続する**（停止に格上げしない）。サマリに出る |
| 19 | auto が approve / reject / halt の resume / recaptureBaseline を呼ばない | 呼ばないこと（halt した state で auto を起動し、state が変わらないことを確かめる振る舞いのテスト + import の検査） |
| 20 | 表示・`auto.*` イベントに生 session ID が出ない | grep テスト（M3 / M4 の防衛線2 の対象を広げる） |
| 21 | **executor 宣言を消して clipboard に戻す** | auto は A2 で止まる（不変条件5 のロールバック可能性） |
| 22 | drive の載せ替え前後で、到達しうる全状態に対する判定が同じ | 判定器の抽出が挙動を変えないこと（課題E）。変わる点は課題E の表の1・2だけで、それ以外は同じ |
| 23 | **無進行タイムアウト**（`timeoutKind: idle`） | 即時ではなく**5分待ってから**1回再試行する。総上限タイムアウトは即時（#6 の承認時の修正） |
| 24 | **遷移の直後の普通の状態**（current-status.json が遷移元の宣言のまま）で auto を起動 | **止まらずに exec する**。stale の検査は exec の後にだけ行う（課題E の初版の誤りの再発防止） |

---

# 推奨案（まとめ）

- **`aiw auto` を別コマンドとし、判定器を drive・next と共有する**（課題E）
- 区間の境界は **clipboard（A2）と、ステップごとの `auto: true` の宣言（A3）の2つ**。
  最初は implementation / review / fix / improve-check の4つだけに付け、research は付けない（段階制）
- 予算は **workflow.yaml から導出した 8**。正常な経路では当たらない値（課題C）
- 再試行は **総上限タイムアウト 1回即時 / 無進行タイムアウト 5分待って1回 / その他の transient 3回（5・15・30分）**。
  判断に失敗の結果ではなく auto 自身の中断フラグを使う（課題D）
- 安全弁は **起動時の構造検査 + 無進行の弁 + 予算**。ステップ別の回数上限は入れない（課題H）
- 終了コードは **0 = 人の番 / 1 = 起動拒否・想定外 / 2 = halt / 3 = 予算 / 4 = executor 失敗 / 5 = 無進行 / 130 = 中断**（課題G）
- **D2（モデルフォールバック）と I（status の機械導出）は後続枠**。どちらも M5 のやらないこと（executor / 契約の変更）に当たる前提を持つ

---

# 実装スコープ（承認後）

## 段階1: 判定器の抽出（**独立コミット**・auto を載せる前）

- 故障注入 #22 を**載せ替えの前に**書く（今の drive / next の判定を固定してから動かす）。
  drive のループには自動テストが無い（対話ループのため。Test 106 のコメント）ので、
  **実物の `runDrive` をサブプロセスで動かす特性テスト**を足す。対象は分岐の中で終了する経路
  （ステップ不明 / 終端 / halt に n と答える）に限る——クリップボードや executor へ進む経路を
  サブプロセスで動かすとユーザーの OS クリップボードを汚すため。それらの経路は判定器の単体テストで固定する。
  課題E の表の1・2はちょうどこの「分岐の中で終了する経路」に含まれるので、変化を実物で示せる
- `classifySituation` を engine に作り、`nextSuggestion` と drive を載せ替える。
  判定器は state だけで決まる状況だけを返す（stale / clipboard / 区間は入れない・課題E）
- **優先順位表（課題E）を組み合わせのテストで固定**する
- **終端が2つの workflow のテスト**を1本足す（drive と next の両方）
- コミットは2つに分ける: (1) 今の挙動を固定するテストだけ（src は変えない）(2) 判定器の抽出と載せ替え。
  (2) で書き換わる期待値の差分が、そのまま「統一で変わった点」の証拠になる
- **統一で挙動が変わった点を完了報告で列挙する**。出発点は課題E の表（1: 未定義ステップと halt 等の同時成立、2: 終端の判定）。
  表に無い変化が見つかったら、それも列挙する
- この段階のコミットには auto のコードを含めない

## 段階2: auto 本体（防衛線と同一コミット）

- `aiw auto`（`--quiet` / `--json` / `--max-steps`）
- 区間の宣言 `steps.<id>.auto: true`（ローダーの検証と、BL-219 の「読まれないキー」の表への登録を同一コミット）。
  runtime の workflow.yaml では **implementation / review / fix / improve-check の4つだけ**に付ける（research は付けない）
- 停止条件表（課題A）・予算・再試行・無進行の弁・起動時の構造検査・ロック・シグナル・終了コード
- `auto.started` / `auto.retry` / `auto.stopped` イベント
- 故障注入 #1-#21

## 段階3: 表示

- 停止サマリ・`status --summary` の auto の欄・`--json`

## 段階4: 実運用

- 区間②→③（implementation → review）から始める。最初の実タスクで停止とサマリを確認してから、区間③→（fix ⇄ improve-check）へ広げる
- baseline に auto の運用開始を記録する（課題J）

## 後続枠（M5 には入れない）

- **D2**: executor に `transientCause` を足す小枠（BL-238。**M5 と並行して先に入れてよい**）→ フォールバック本体
- **I**: BL-213 の解消 → status の機械導出（BL-239。鮮度の証明を失わないことが設計条件）
- **research の区間への組み入れ**: 4ステップの区間で auto の停止挙動を実測してから判断（BL-240）

---

# 実装の開始条件

| # | 条件 | 現在 |
| --- | --- | --- |
| 1 | `npm test` が全件 green | ✅ 228 / 228（2026-09-25） |
| 2 | Stage 0 の4条件 | ✅（上の判定表） |
| 3 | この設計文書が承認されている | ✅ 2026-09-25（論点8件すべて決着・#6 は修正つき） |
| 4 | 故障注入リスト（**24件**。承認時の修正で #23・#24 を追加）の合意 | ✅ 2026-09-25（「その進め方で承認。実装へどうぞ」） |
| 5 | 未解決の論点 #1（区間の宣言方式）が決まっている | ✅ `auto: true`・research は付けない |
| 6 | タスク境界にいる | 実装着手時に確認（2026-09-25 時点は research の途中） |

---

# 決定ログ

**決めたことはここへ追記する**（codex / claude の設計文書と同じ運用）。

| 日付 | 論点 | 決定 | 根拠 |
| --- | --- | --- | --- |
| 2026-09-17 | Stage 0（初回） | **4条件すべて未達で停止** | archiveFeature 未コミット / fix × codex n=0 / BL-221 open / M4 完了行が未訂正 |
| 2026-09-25 | Stage 0（再判定） | **4条件すべて充足** | 上の判定表。fix × codex は n=4 |
| 2026-09-25 | **区間の宣言**（論点 #1） | **ステップごとの `auto: true`**（既定 false）。**最初は implementation / review / fix / improve-check の4つだけ。research には付けない**（段階制。組み入れは停止挙動を見てから・BL-240） | 安全側の既定で、新しいステップが黙って無人区間に入らない。executor 宣言と同じ形（宣言のあるステップだけが対象）で思想も揃う。research は `ux-decision-required` で自分に戻る唯一のステップ |
| 2026-09-25 | D2 の位置づけ（論点 #2） | **後続枠**。前提の `transientCause` 小枠は M5 と並行して先に入れてよい（BL-238） | 発動の判定材料が executor の返り値に無く、executor の変更は M5 のやらないこと |
| 2026-09-25 | D2 の使い切り（論点 #3） | **auto の停止（終了コード 4・state は変わらない）**。エンジンの halt にしない | exec の失敗は state を変えない（不変条件1）からの導出 |
| 2026-09-25 | D2 の範囲（論点 #4） | **起動1回の中だけ**。次のステップは pin からやり直す | 混雑は一時的、pin が正、の関係を保つ最小の形 |
| 2026-09-25 | I の位置づけ（論点 #5） | **後続枠**（BL-239）。前提は BL-213 の解消。**設計条件: 鮮度の証明を失わないこと** | 契約の変更が前提。auto の区間での効果は観測上ゼロ |
| 2026-09-25 | 再試行（論点 #6・**修正つき**） | 総上限タイムアウト: **即時に1回** / 無進行タイムアウト: **5分待って1回** / その他の transient: 5・15・30分の3回 / 起動あたり上限 6 | 承認時の修正: idle の即時再試行は、止まった原因（BL-054 型のハングなど）が残ったまま同じ壁へ再突入しやすく1回を無駄にする。**total / idle を分けた設計が初めて挙動の分岐に使われる** |
| 2026-09-25 | 同時実行のロック（論点 #7） | **入れる**（必須） | — |
| 2026-09-25 | 終了コード（論点 #8） | **0 / 1 / 2 / 3 / 4 / 5 / 130** | 既存の 0 / 1 / 2 の意味を変えない |
| 2026-09-25 | 判定器の統一の進め方（承認時の注文） | **独立コミット**。載せ替えの前に drive / next の判定をテストで固定し、統一で変わった点を完了報告で列挙する。設計時点の洗い出しは課題E の表（2点） | 順序のずれを直した瞬間に drive の挙動が変わりうる（今のずれに依存した運用がありうる） |
| 2026-09-25 | **判定の優先順位**（承認時の注文） | halted > 承認待ち > チェックポイント > 終端 > 不明 > 通常 を**課題E に1列で宣言し、テストで固定**する。条件を足すときは表とテストに同じ行を足す | 同時に成り立つ条件のどれを見せるかは if の並びで暗黙に決まってしまう。判定器の存在意義は順序が1箇所に書かれテストで固定されていること |
| 2026-09-25 | **終端が2つのワークフローのテスト**（承認時の注文） | 終端を2つにした workflow で、drive と next が両方の終端で正しく終わることを1本固定する | config からの導出は「終端が増えても壊れない」ためのもの。宣言ではなく実証にする |
| 2026-09-25 | 実装の着手 | **承認**。段階1（判定器の抽出）から着手し、完了報告では (1) 課題E の表の最終版 (2) 優先順位表とそのテスト (3) drive / next の既存テストが無傷であること、の3点を出す | 「その進め方で承認。実装へどうぞ」 |
| 2026-09-25 | **初版の誤りの訂正 1**: stale の判定位置 | 判定器（exec の前）から外し、**exec の後・run の前**へ移す。故障注入 #24 を追加 | 遷移の直後は毎回 stale が成立する（`lastCompletedStep` = 遷移元・status は遷移元の宣言のまま）。初版のままだと auto は全ステップの手前で止まる |
| 2026-09-25 | **初版の誤りの訂正 2**: BL 番号 | 本文の「BL-116」をすべて **BL-213** へ | 2026-09-17 の振り直し（旧 116 → 新 213）を反映していなかった。アプリ側には別件の BL-116（resolved）がある |

---

# 未解決の論点（判断を委ねる）

**残り 0 件**（2026-09-25 に8件すべて決着・決定ログへ移した）。
実装中に新たな論点が出たら、この表へ足してから決める。
