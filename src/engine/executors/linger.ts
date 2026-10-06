// 最終イベントの後に終わらない子プロセスを片付ける（BL-279・2026-10-06）。codex / claude の両方が使う。
//
// 実測（2026-10-06）: codex が最終メッセージ（turn.completed）を出した後もプロセスが終了せず、aiw は `close` を待ち続けた。
// 見張り（総上限・無進行）に任せると、撃った時点で「中断」扱いになり、auto は出来上がった成果物を作り直す再試行に入る（BL-280）。
// そこで**最終イベントを受け取った後だけ**猶予を置き、それでも終わらなければ子を止めて「完了」として扱う。
//
// ⚠️ 成否はこれまでどおり validator が決める（exit 0 が作業をした証拠にならないのと同じで、ここも「プロセスの片付け」でしかない）。
// ⚠️ 最終イベントより前の固まりは扱わない（そちらは見張りの担当のまま）。
// ⚠️ 黙って直さない: 発火したら meta.lingeringAfterCompletion に残し、画面にも1行出す（呼び出し側）。

/** 最終イベントの後、終了を待つ猶予の既定。通常の終了は 1 秒未満なので十分に長く、無進行（900 秒）よりは十分に短い */
export const DEFAULT_LINGER_GRACE_MS = 120_000;

export type LingerGuard = {
  /** 最終イベントを受け取ったら呼ぶ。2回目以降は何もしない */
  finalSeen(): void;
  /** 子の終了（close / error）で呼ぶ。タイマーを止める */
  dispose(): void;
  /** 猶予が切れて子を止めたか */
  readonly fired: boolean;
};

export function createLingerGuard(opts: { graceMs: number; kill: () => void }): LingerGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let disposed = false;
  return {
    finalSeen() {
      if (timer || fired || disposed) {
        return;
      }
      timer = setTimeout(() => {
        fired = true;
        opts.kill();
      }, opts.graceMs);
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    get fired() {
      return fired;
    }
  };
}
