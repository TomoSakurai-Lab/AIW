// セッション識別子の型分離（M3・不変条件6）。
//
// 不変条件6: 「session の生 ID をログに残さない。hash または末尾識別子のみ」。
// これは CLAUDE.md で **強制: なし** の項目であり、M3 で初めて破れるコードが生まれる
// （codex の JSONL に `thread.started.thread_id` が入るため、段階1でもログ経路に乗る）。
//
// 防ぎ方は「気をつける」ではなく **型で持てなくする**。
// `versions.ts` の skillHash が「生の値ではなく hash を持つ」を型で表現しているのと同じ形。
//
//   SessionSecret … 生の値。プロセス起動の引数にしか渡さない
//   SessionRef    … ログ・Event Log・成果物へ出せる唯一の形
//
// ⚠️ SessionRef から生の値へ戻す関数は **作らない**。作った瞬間にこの分離は無意味になる。
import { createHash } from "node:crypto";

/** 生のセッション識別子。**ログ経路へ渡してはならない。** */
export type SessionSecret = {
  readonly kind: "session-secret";
  readonly raw: string;
};

/** ログへ出せる参照。hash と末尾のみを持ち、生の値を復元できない。 */
export type SessionRef = {
  readonly hash: string;
  /** 末尾4文字。人間が「さっきのと同じか」を目視で照合するための識別子 */
  readonly tail: string;
};

export function sessionSecret(raw: string): SessionSecret {
  return { kind: "session-secret", raw };
}

/** 生 → 参照。**この向きにしか変換しない。** */
export function toSessionRef(secret: SessionSecret): SessionRef {
  const hash = createHash("sha256").update(secret.raw).digest("hex");
  return { hash: `sha256:${hash}`, tail: secret.raw.slice(-4) };
}

/**
 * 文字列から既知のセッション ID 断片を伏せる。
 *
 * 表示経路（onProgress の1行サマリなど）は codex のイベントを素材にするため、
 * 生 ID が紛れ込みうる。**出す直前で落とす**のが最後の砦。
 */
export function redactSession(text: string, secret: SessionSecret | null): string {
  if (!secret || secret.raw.length === 0) {
    return text;
  }
  return text.split(secret.raw).join(`<session:${secret.raw.slice(-4)}>`);
}
