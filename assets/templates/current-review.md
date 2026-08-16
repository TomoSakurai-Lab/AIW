# Summary

## Specification Coverage Audit

<!--
実装が current-task.md / context-package.md の Source Requirements を満たしているか。
満たしていない項目は Critical / Major へ落とす。
Fix が必要になった場合、原因が「実装の瑕疵」か「research の瑕疵」かをここで分類する。
-->

## Acceptance Criteria Evidence Audit

<!--
AC ごとに、current-result.md の Status と Evidence が実在するかを突き合わせる。
- 検証していないのに PASS になっていないか（三値を二値へ丸めていないか）
- Evidence に挙がったテスト名・出力が実在するか
-->

## Manual Verification Audit

## Risk Area Audit

<!--
- research-findings.md の Inferred Behavior の**算出根拠を検算する**
  （式・参照元・測定方法をたどり直し、数値が正しいかを確かめる）
- Open Decisions が実装で無断確定されていないか
- High Risk 差分
-->

## Critical

## Major

## Minor

## Good

## Backlog

## Ready

## Verification Data

<!--
**fix が検証で使う具体値を書く場所。** fix はここの値をそのまま検証に使う。
- seed / テストデータの実値（どの行の何が幾つか）
- 再現手順（どの画面をどう開き、どの行を操作するか）
- 検証時の期待値（操作前 / 操作後 / Undo 後 など）
⚠️ 「適切な値」「実測値」のような抽象記述は不可。実際の数値・文字列を書く。
-->

## Fix Scope

### Files To Modify

### Critical

### Major

### Acceptance Criteria

### Test Required
