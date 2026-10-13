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

/**
 * 子が終了（'exit'）した後、'close' を待つ上限の既定（BL-284・2026-10-13）。
 *
 * 実測（2026-10-13）: codex は turn.completed を出したが、aiw は 'close' を 2 時間待ち続け、猶予（上の linger）も総上限も効かなかった。
 * 'close' は「子が終了し、**かつ** stdio の口がすべて閉じた」ときにしか来ない。codex がテスト中に起動した vite などの孫が
 * 生き残って口（継承されたハンドル）を握ると、子が死んでも 'close' は永遠に来ない（実験で再現: exit は 299ms、close は来ない）。
 * kill も効かない（止める相手の子はもう終わっている）。だから**終了は 'exit' で知り**、口の排出だけをこの時間待つ。
 */
export const DEFAULT_STDIO_DRAIN_MS = 10_000;

type SettleableChild = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close" | "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

export type ChildSettlement = {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  /** 子は終了したが drainMs 以内に 'close' が来ず、こちらから口を閉じた */
  stdioHeld?: true;
};

/**
 * 子の終わりを待つ。通常は 'close'。'exit' の後 drainMs 待っても 'close' が来なければ、口を壊して終了コードで返す。
 * ⚠️ 黙って直さない: 発火したら onStdioHeld を呼ぶ（呼び出し側が画面と meta に残す）。生き残った孫は止めない（誰のものか分からない）。
 */
export function waitForChild(child: SettleableChild, opts: { drainMs: number; onStdioHeld: () => void }): Promise<ChildSettlement> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (s: ChildSettlement) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(s);
    };
    child.on("error", (err) => finish({ code: null, signal: null, spawnError: err }));
    child.on("close", (code, signal) => finish({ code, signal }));
    child.on("exit", (code, signal) => {
      if (done || timer) return;
      timer = setTimeout(() => {
        if (done) return;
        opts.onStdioHeld();
        for (const s of [child.stdout, child.stderr]) {
          (s as { destroy?: () => void } | null)?.destroy?.();
        }
        finish({ code, signal, stdioHeld: true });
      }, opts.drainMs);
    });
  });
}

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
