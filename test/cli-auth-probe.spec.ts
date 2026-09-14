import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeCliAuth } from '../src/main/cli-auth-probe';
import type { CliAuthStatus } from '../src/shared/cli-auth';
import { FakeProcessSpawner } from './fakes/fake-process';
import type { FakeChildProcess } from './fakes/fake-process';

let spawner: FakeProcessSpawner;

beforeEach(() => {
  spawner = new FakeProcessSpawner();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 跑一次探測：兩個行程都是同步 spawn 出來的，所以可以馬上餵資料。*/
function probe(
  feed: (claude: FakeChildProcess, codex: FakeChildProcess) => void,
): Promise<CliAuthStatus> {
  const status = probeCliAuth(spawner);
  feed(spawner.spawned[0], spawner.spawned[1]);
  return status;
}

const ok = (child: FakeChildProcess, stdout: string): void => {
  child.emitStdout(stdout);
  child.emitExit(0);
};

describe('probeCliAuth 組出來的命令', () => {
  it('claude 直接跑，codex 一定要經過 cmd.exe', () => {
    void probeCliAuth(spawner);
    expect(spawner.spawned.map((child) => child.spec.file)).toEqual(['claude', 'cmd.exe']);
    expect(spawner.spawned[0].spec.args).toEqual(['auth', 'status']);
    expect(spawner.spawned[1].spec.args).toEqual(['/c', 'codex', 'login', 'status']);
  });
});

describe('probeCliAuth', () => {
  it('兩邊都登入時各自回報登入方式', async () => {
    const status = await probe((claude, codex) => {
      ok(claude, '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
      ok(codex, 'Logged in using ChatGPT\n');
    });

    expect(status.claude).toMatchObject({ mode: 'subscription', label: 'Max 訂閱' });
    expect(status.codex).toMatchObject({ mode: 'subscription', label: 'ChatGPT 訂閱' });
  });

  it('codex 把登入狀態印在 stderr，一樣要讀得到', async () => {
    const status = await probe((claude, codex) => {
      ok(claude, '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
      codex.emitStderr('Logged in using ChatGPT\n');
      codex.emitExit(0);
    });

    expect(status.codex).toMatchObject({ mode: 'subscription', label: 'ChatGPT 訂閱' });
  });

  it('分次送到的輸出會接起來再解析', async () => {
    const status = await probe((claude, codex) => {
      claude.emitStdout('{"loggedIn":true,');
      claude.emitStdout('"authMethod":"apiKey"}');
      claude.emitExit(0);
      ok(codex, 'Not logged in');
    });

    expect(status.claude).toMatchObject({ mode: 'api', label: 'API 金鑰' });
    expect(status.codex).toMatchObject({ loggedIn: false, label: '未登入' });
  });

  it('spawn 失敗 (ENOENT) 是找不到指令，cmd.exe 的 9009 也是', async () => {
    const status = await probe((claude, codex) => {
      claude.emitStderr('spawn claude ENOENT');
      claude.emitExit(-1);
      codex.emitExit(9009);
    });

    expect(status.claude.label).toBe('找不到指令');
    expect(status.codex.label).toBe('找不到指令');
  });

  it('其他非零離開碼只能說無法判斷', async () => {
    const status = await probe((claude, codex) => {
      claude.emitStderr('something broke');
      claude.emitExit(1);
      ok(codex, 'Logged in using ChatGPT');
    });

    expect(status.claude).toEqual({ loggedIn: false, mode: 'unknown', label: '無法判斷' });
  });

  it('十秒沒回話就砍掉行程並放棄，不會卡住開機', async () => {
    vi.useFakeTimers();
    const status = probeCliAuth(spawner);
    ok(spawner.spawned[1], 'Logged in using ChatGPT');

    vi.advanceTimersByTime(10_000);

    expect(spawner.spawned[0].killed).toBe(true);
    expect((await status).claude.label).toBe('無法判斷');
    expect((await status).codex.mode).toBe('subscription');
  });

  it('探測完之後才回報的離開碼不會蓋掉結果', async () => {
    vi.useFakeTimers();
    const status = probeCliAuth(spawner);
    ok(spawner.spawned[0], '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
    ok(spawner.spawned[1], 'Logged in using ChatGPT');

    vi.advanceTimersByTime(10_000);
    spawner.spawned[0].emitExit(1);

    expect((await status).claude.label).toBe('Max 訂閱');
  });
});
