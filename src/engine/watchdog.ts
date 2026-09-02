// 実行の見張り: 総上限と「無進行」の二段構え。
//
// **executor の外に置く。** codex / claude のどちらから呼んでも同じ機構が効く。
// codex.ts の中に入れると M4 で claude.ts に同じものをもう一度書くことになり、
// 二重管理になる（M4.4 の「共通化すべきか」の判断材料でもある）。
//
// ## なぜ二段構えなのか（実測が根拠）
//
// implementation のタイムアウトは累計5件。**全件が (a) 型 = 働いている最中の打ち切り**で、
// stall（無進行）は 0 件だった。裾のタスクが総上限 1800s を恒常的に叩いていた。
//
// | # | 実行時間 | 最終書込→kill | 最後のイベント |
// | --- | ---: | ---: | --- |
// | 08-25 #1 | 2037s | **412.3s** | E2E 実行中（既存失敗がタイムアウトまで走る旨の agent_message） |
// | 08-25 #2 | 1808s | 19.4s | 検証継続中 |
// | 08-28    | 1800s | 3.3s | todo_list 更新 |
// | 08-31    | 1895s | 112.4s | PowerShell のプロセス確認が in_progress |
// | 09-01    | 1801s | 19.8s | `nrun.cmd build` が in_progress |
//
// 総上限を延ばすだけだと、**本物の stall の発見が 30 分 → 60 分へ遅くなる**。
// そこで「総上限は延ばす（裾を殺さない）」＋「無進行は別に短く見る（stall を速く見つける）」。
//
// ## 閾値の根拠（**推測ではなく実測から出す**。token-range と同じ順序）
//
// ⚠️ **JSONL にタイムスタンプが無い**ので、イベント間隔は直接測れない。
// 無進行時間の正体は「1コマンドの所要時間」——`command_execution` は `item.started` の後、
// 完了までイベントを一切出さないため。そこでコマンドの実測所要を代理指標にした:
//
// | 種別 | n | 中央 | 最大 |
// | --- | ---: | ---: | ---: |
// | Playwright / E2E | 16 | 192s | **294s** |
// | その他テスト | 37 | 13s | 54.8s |
// | verify-local typecheck | 102 | 5.8s | 14.6s |
// | dotnet / nrun build | **0** | — | **未測定** |
//
// 加えて **08-25 #1 の 412.3s** が「働いている最中の沈黙」の実測最大。E2E 実行中に
// 切られたので**真の所要の下界**でしかない。412.3 × 2 = 824s に余裕を足して **900s** を既定にした。
//
// ⚠️ **300s にしてはいけない。** 08-25 #1 を誤って kill する。
// 「検査できなかった」を「違反があった」に潰す consumer-presence の失敗の、時間版になる。
// build 系が未測定である以上、真の最大は不明なので保守側に置く。測れたら締めてよい。

/** 総上限の既定。実測の implementation 中央値 ~15 分に対し 4 倍。裾（34 分の実績）を殺さない */
export const DEFAULT_TOTAL_TIMEOUT_MS = 3_600_000;

/** 無進行の既定。実測された working silence の最大 412.3s の約 2.2 倍（上のコメント参照） */
export const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

/** どちらの見張りが撃ったか。**1つに潰さない**（三値の規律と同じ理由） */
export type TimeoutKind = "total" | "idle";

export type WatchdogOptions = {
  totalTimeoutMs: number;
  idleTimeoutMs: number;
  /** 外から渡された中断シグナル。撃たれたら watchdog も一緒に止まる */
  externalSignal?: AbortSignal;
  /** テスト用の時計。既定は Date.now */
  now?: () => number;
  /** テスト用のタイマー。既定は setTimeout / clearTimeout */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type Watchdog = {
  /** executor へ渡す signal。総上限・無進行・外部中断のいずれでも abort する */
  signal: AbortSignal;
  /** 進行イベントが来たことを知らせる。無進行タイマーが延長される */
  notify: () => void;
  /** 撃った見張りの種類。まだ撃っていなければ null */
  firedKind: () => TimeoutKind | null;
  /** タイマーを片付ける。**必ず finally で呼ぶこと** */
  dispose: () => void;
};

/**
 * 総上限と無進行を同時に見張る。
 *
 * ⚠️ **abort は「止めてくれ」の合図でしかない。** 実測では SIGTERM から実際の終了まで
 * 最大 237s かかっている（08-25 #1: 上限 1800s に対し実測 2037s）。
 * 「idle 900s で撃つ」は「900s + α で終わる」であって、900s で終わるではない。
 */
export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const controller = new AbortController();
  let fired: TimeoutKind | null = null;
  let idleHandle: unknown = null;
  let totalHandle: unknown = null;
  let disposed = false;

  const fire = (kind: TimeoutKind): void => {
    if (fired !== null || disposed) {
      return; // 二重発火しない。**最初に撃った理由を上書きしない**
    }
    fired = kind;
    controller.abort();
  };

  const armIdle = (): void => {
    if (disposed) {
      return;
    }
    if (idleHandle !== null) {
      clearTimer(idleHandle);
    }
    idleHandle = setTimer(() => fire("idle"), opts.idleTimeoutMs);
  };

  totalHandle = setTimer(() => fire("total"), opts.totalTimeoutMs);
  armIdle();

  // 外部からの中断は watchdog の発火ではない（firedKind は null のまま）。
  // 「人間が止めた」を「タイムアウトした」と記録しないため。
  const onExternal = (): void => {
    if (!disposed) {
      controller.abort();
    }
  };
  opts.externalSignal?.addEventListener("abort", onExternal, { once: true });
  if (opts.externalSignal?.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    notify: armIdle,
    firedKind: () => fired,
    dispose: () => {
      disposed = true;
      if (idleHandle !== null) {
        clearTimer(idleHandle);
      }
      if (totalHandle !== null) {
        clearTimer(totalHandle);
      }
      opts.externalSignal?.removeEventListener("abort", onExternal);
    }
  };
}

/**
 * KI-08 の二重判定を watchdog にも適用する。
 *
 * タイマーが撃ったという内部フラグだけを信じない——実測時間からも裏を取る。
 * 逆に、撃っていないのに時間だけ超えている場合（タイマーが遅れた・時計が飛んだ）も
 * タイムアウトとして扱う。`null` は「タイムアウトではない」。
 */
export function classifyTimeout(
  fired: TimeoutKind | null,
  durationMs: number,
  totalTimeoutMs: number
): TimeoutKind | null {
  if (fired !== null) {
    return fired;
  }
  return durationMs >= totalTimeoutMs ? "total" : null;
}
