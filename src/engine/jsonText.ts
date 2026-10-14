// JSON を読む口を1つにする（BL-285・2026-10-14）。
//
// 実測（10-13〜14）: codex が PowerShell 5.1 で書いた current-status.json / ac-manifest.json の先頭に UTF-8 BOM が付き、
// JSON.parse が `Unexpected token '﻿'` で落ちた。current-status.json は json-schema（halt）なので 4 回 halt し、
// ac-manifest.json は manifest を読めずに consumer-presence などの計測がその回だけ抜けた。
//
// BOM は文字コードの付け足しで中身ではない（RFC 8259 も「読む側は BOM を無視してよい」）。無視しても中身の検査は弱くならない。
// ⚠️ **読む口を1つにする理由**: どこか1箇所だけ BOM を許すと、「検証は通ったのに後段の読み込みで落ちる」食い違いが生まれる。
// ⚠️ 黙って直さない: 呼び出し側（validator）は bom を見て、メッセージと detail.bomIgnored に残す（Event Log で件数を追う）。

const BOM = "﻿";

export type ParsedJson = { value: unknown; bom: boolean };

/** 先頭の BOM を1つだけ取り除いて JSON.parse する。不正な JSON はこれまでどおり例外。 */
export function parseJsonText(raw: string): ParsedJson {
  const bom = raw.startsWith(BOM);
  return { value: JSON.parse(bom ? raw.slice(BOM.length) : raw), bom };
}
