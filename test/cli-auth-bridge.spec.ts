import { describe, it, expect, beforeEach } from 'vitest';
import { cliAuthBridge } from '../src/main/cli-auth-bridge';
import type { CliAuthBridge } from '../src/main/cli-auth-bridge';
import { probeCliAuth } from '../src/main/cli-auth-probe';
import { CliAuthStore } from '../src/main/cli-auth-store';
import { FakeProcessSpawner } from './fakes/fake-process';

let spawner: FakeProcessSpawner;
let bridge: CliAuthBridge;

/** 這一份不驗解析，只驗探測跑了幾輪，所以金鑰與 Muse 憑證檔都當成沒有。*/
beforeEach(() => {
  spawner = new FakeProcessSpawner();
  bridge = cliAuthBridge(
    () =>
      probeCliAuth(
        spawner,
        () => false,
        () => null,
      ),
    new CliAuthStore(
      () => null,
      () => {},
      { encrypt: (plain) => plain, decrypt: (secret) => secret },
    ),
  );
});

/** 一輪探測是四個行程 (claude 在最前面)；讓這一輪的四個一次回完。*/
function settle(from = 0): void {
  const round = spawner.spawned.slice(from);
  round[0].emitStdout('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
  for (const child of round) child.emitExit(0);
}

describe('cliAuthBridge', () => {
  it('探測中再按一次「重新偵測」不會多跑一輪，拿到的是同一個 Promise', async () => {
    const first = bridge.refresh();
    const second = bridge.refresh();

    expect(first).toBe(second);
    expect(spawner.spawned).toHaveLength(4);

    settle();
    expect((await first).claude.label).toBe('Max 訂閱');
  });

  it('上一輪探完之後再按就真的重探一次', async () => {
    const first = bridge.refresh();
    settle();
    await first;

    const second = bridge.refresh();
    expect(second).not.toBe(first);
    expect(spawner.spawned).toHaveLength(8);
    settle(4);
    await second;
  });

  it('還沒開始探之前問到的 status()，等的就是第一次的結果', async () => {
    const status = bridge.status();
    expect(spawner.spawned).toHaveLength(0);

    void bridge.refresh();
    settle();

    expect((await status).claude.label).toBe('Max 訂閱');
  });

  it('探完之後 status() 就是最近那一份，不會再探', async () => {
    const run = bridge.refresh();
    settle();
    await run;

    expect(await bridge.status()).toBe(await run);
    expect(spawner.spawned).toHaveLength(4);
  });

  it('latest() 讓金額標示同步問得到結果，探完之前是 null', async () => {
    expect(bridge.latest()).toBeNull();

    const run = bridge.refresh();
    settle();
    await run;

    expect(bridge.latest()?.claude.mode).toBe('subscription');
  });
});
