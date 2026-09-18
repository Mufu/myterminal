import type { CliAuthStatus } from '../shared/cli-auth';
import type { CliAuthStore } from './cli-auth-store';

/** CLI 設定與登入狀態：誰存的、怎麼重探，由 index.ts 組起來。*/
export interface CliAuthBridge {
  /** 目前這一份探測結果；還沒開始探的時候等的就是第一次的結果。*/
  status(): Promise<CliAuthStatus>;
  /** 重探一次，並成為新的 status()。*/
  refresh(): Promise<CliAuthStatus>;
  /** 最近一次探完的結果，探完之前是 null —— 金額怎麼標示要同步問得到。*/
  latest(): CliAuthStatus | null;
  store: CliAuthStore;
}

/**
 * 把「探測一次」包成 bridge。
 * 探測中再呼叫 refresh() 不會再開四個行程，拿到的是同一個 Promise ——
 * 「重新偵測」連按、或它跟登入流程結束撞在一起時都只探一輪。
 */
export function cliAuthBridge(
  probe: () => Promise<CliAuthStatus>,
  store: CliAuthStore,
): CliAuthBridge {
  /** 正在跑的那一輪；沒有在探的時候是 null。*/
  let inFlight: Promise<CliAuthStatus> | null = null;
  let latest: CliAuthStatus | null = null;
  // 開機那一輪也是走 refresh()，所以在它開始之前問到的 status() 是一個
  // 還沒結算的 Promise —— 等第一次探完才有答案，不會先給一個假的。
  let resolveFirst: ((status: CliAuthStatus) => void) | null = null;
  let current = new Promise<CliAuthStatus>((resolve) => (resolveFirst = resolve));

  const refresh = (): Promise<CliAuthStatus> => {
    if (inFlight) return inFlight;
    const run = probe().then((status) => {
      inFlight = null;
      latest = status;
      resolveFirst?.(status);
      resolveFirst = null;
      return status;
    });
    inFlight = run;
    current = run;
    return run;
  };

  return {
    status: () => current,
    refresh,
    latest: () => latest,
    store,
  };
}
