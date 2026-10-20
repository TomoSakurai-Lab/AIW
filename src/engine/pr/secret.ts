// Azure DevOps の PAT の型分離（aiw pr・docs/design-pr.md §F-1）。
//
// session.ts の SessionSecret と同じ規律: 「気をつける」ではなく **型で漏らせなくする**。
// SessionSecret は `raw` を公開フィールドに持つが、PAT は JSON.stringify や console.log に
// オブジェクトごと渡った時点で漏れるので、**値を private フィールドに隠す**。
//
//   PatSecret.reveal() … 生の値。**呼んでよいのは azdo.ts の Authorization ヘッダ組み立て 1 箇所だけ**
//                        （test 267 が呼び出し箇所を数える）
//   redactPat()        … 出力の最終段（stdout / stderr / Event Log）で PAT と base64 形を伏せる
//
// ⚠️ base64(":" + PAT) も秘密として扱う。Basic 認証のヘッダ値そのものなので、
// 応答やエラーに echo されると PAT と同じ価値を持つ。
import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

/** env `AZURE_DEVOPS_PAT` から読んだ値。**ログ経路へ渡しても値が出ない。** */
export class PatSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** 生の値。**azdo.ts の Authorization ヘッダ以外で呼ばない。** */
  reveal(): string {
    return this.#value;
  }

  /** 伏せる対象の文字列（生の値と、Basic 認証のヘッダ値の base64 形）。 */
  forms(): string[] {
    if (this.#value === "") {
      return [];
    }
    return [this.#value, Buffer.from(`:${this.#value}`, "utf8").toString("base64"), Buffer.from(this.#value, "utf8").toString("base64")];
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** env 名。**設定ファイルに PAT のキーは作らない**（書ける場所を作らないのが一番強い）。 */
export const PAT_ENV = "AZURE_DEVOPS_PAT";

/** env から読む。未設定・空文字は null（呼び出し側が案内を出して終わる）。 */
export function patFromEnv(env: NodeJS.ProcessEnv): PatSecret | null {
  const raw = env[PAT_ENV];
  return typeof raw === "string" && raw.trim() !== "" ? new PatSecret(raw.trim()) : null;
}

/** 文字列から PAT と base64 形を伏せる。**出す直前で落とす**のが最後の砦（redactSession と同じ位置づけ）。 */
export function redactPat(text: string, secret: PatSecret | null): string {
  if (!secret) {
    return text;
  }
  let out = text;
  for (const form of secret.forms()) {
    out = out.split(form).join(REDACTED);
  }
  return out;
}
