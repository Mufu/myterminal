import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeCliAuth } from '../src/main/cli-auth-probe';
import type { CliAuthStatus, CliId } from '../src/shared/cli-auth';
import { FakeProcessSpawner } from './fakes/fake-process';
import type { FakeChildProcess } from './fakes/fake-process';

let spawner: FakeProcessSpawner;
/** Muse 的憑證檔內容；null 代表檔案不存在 (從沒登入過)。*/
let museFile: string | null;
let storedKeys: Set<CliId>;

beforeEach(() => {
  spawner = new FakeProcessSpawner();
  museFile = null;
  storedKeys = new Set();
});

afterEach(() => {
  vi.useRealTimers();
});

const start = (): Promise<CliAuthStatus> =>
  probeCliAuth(
    spawner,
    (id) => storedKeys.has(id),
    () => museFile,
  );

const ok = (child: FakeChildProcess, stdout: string): void => {
  child.emitStdout(stdout);
  child.emitExit(0);
};

/** 四支都成功回話的基本盤；測試只覆寫自己在意的那一支。*/
const DEFAULTS: Record<CliId, (child: FakeChildProcess) => void> = {
  claude: (c) => ok(c, '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'),
  codex: (c) => ok(c, 'Logged in using ChatGPT\n'),
  muse: (c) => ok(c, 'Muse Code 1.3.0 (1.3.0-R3057.1)\n'),
  opencode: (c) => ok(c, '0 credentials\n'),
};

const IDS: CliId[] = ['claude', 'codex', 'muse', 'opencode'];

/**
 * 跑一次探測：四個行程都是同步 spawn 出來的，所以可以馬上餵資料。
 * 每個行程只餵一次 —— 先送到的那個結束事件就定案了。
 */
function probe(
  overrides: Partial<Record<CliId, (child: FakeChildProcess) => void>> = {},
): Promise<CliAuthStatus> {
  const status = start();
  IDS.forEach((id, index) => (overrides[id] ?? DEFAULTS[id])(spawner.spawned[index]));
  return status;
}

describe('probeCliAuth 組出來的命令', () => {
  it('claude 直接跑，codex / muse / opencode 是 .cmd shim 要經過 cmd.exe', () => {
    void start();
    expect(spawner.spawned.map((child) => child.spec.file)).toEqual([
      'claude',
      'cmd.exe',
      'cmd.exe',
      'cmd.exe',
    ]);
    expect(spawner.spawned[0].spec.args).toEqual(['auth', 'status']);
    expect(spawner.spawned[1].spec.args).toEqual(['/c', 'codex', 'login', 'status']);
    // Muse 沒有看登入狀態的指令，--version 只是確認裝了沒有。
    expect(spawner.spawned[2].spec.args).toEqual(['/c', 'muse', '--version']);
    expect(spawner.spawned[3].spec.args).toEqual(['/c', 'opencode', 'auth', 'list']);
  });
});

describe('probeCliAuth', () => {
  it('四支都登入時各自回報登入方式', async () => {
    museFile = JSON.stringify({ providers: { meta: { access_token: 'x' } } });
    const status = await probe({ opencode: (c) => ok(c, '2 credentials\n') });

    expect(status.claude).toMatchObject({ mode: 'subscription', label: 'Max 訂閱' });
    expect(status.codex).toMatchObject({ mode: 'subscription', label: 'ChatGPT 訂閱' });
    expect(status.muse).toMatchObject({ mode: 'subscription', label: 'Meta 帳號' });
    expect(status.opencode).toMatchObject({ mode: 'api', label: 'API 金鑰' });
  });

  it('codex 把登入狀態印在 stderr，一樣要讀得到', async () => {
    const status = await probe({
      codex: (c) => {
        c.emitStderr('Logged in using ChatGPT\n');
        c.emitExit(0);
      },
    });

    expect(status.codex).toMatchObject({ mode: 'subscription', label: 'ChatGPT 訂閱' });
  });

  it('分次送到的輸出會接起來再解析', async () => {
    const status = await probe({
      claude: (c) => {
        c.emitStdout('{"loggedIn":true,');
        c.emitStdout('"authMethod":"apiKey"}');
        c.emitExit(0);
      },
    });

    expect(status.claude).toMatchObject({ mode: 'api', label: 'API 金鑰' });
  });

  it('spawn 失敗 (ENOENT) 是找不到指令，cmd.exe 的 9009 也是', async () => {
    const status = await probe({
      claude: (c) => {
        c.emitStderr('spawn claude ENOENT');
        c.emitExit(-1);
      },
      muse: (c) => c.emitExit(9009),
    });

    expect(status.claude.label).toBe('找不到指令');
    // muse --version 跑不起來就是沒裝，不必再看憑證檔。
    expect(status.muse.label).toBe('找不到指令');
  });

  it('其他非零離開碼只能說無法判斷', async () => {
    const status = await probe({
      claude: (c) => {
        c.emitStderr('something broke');
        c.emitExit(1);
      },
    });

    expect(status.claude).toEqual({ loggedIn: false, mode: 'unknown', label: '無法判斷' });
  });

  it('十秒沒回話就砍掉行程並放棄，不會卡住開機', async () => {
    vi.useFakeTimers();
    const status = start();
    ok(spawner.spawned[1], 'Logged in using ChatGPT');

    vi.advanceTimersByTime(10_000);

    expect(spawner.spawned[0].killed).toBe(true);
    expect((await status).claude.label).toBe('無法判斷');
    expect((await status).codex.mode).toBe('subscription');
  });

  it('探測完之後才回報的離開碼不會蓋掉結果', async () => {
    vi.useFakeTimers();
    const status = start();
    ok(spawner.spawned[0], '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
    ok(spawner.spawned[1], 'Logged in using ChatGPT');

    vi.advanceTimersByTime(10_000);
    spawner.spawned[0].emitExit(1);

    expect((await status).claude.label).toBe('Max 訂閱');
  });
});

describe('probeCliAuth 的 Muse 與 OpenCode', () => {
  it('Muse 裝了但憑證檔不存在就是未登入', async () => {
    const status = await probe();
    expect(status.muse).toMatchObject({ loggedIn: false, label: '未登入' });
  });

  it('Muse 存的是 API 金鑰時 mode 是 api', async () => {
    museFile = JSON.stringify({ schema_version: 1, providers: { meta: { api_key: 'x' } } });
    const status = await probe();
    expect(status.muse).toMatchObject({ mode: 'api', label: 'API 金鑰' });
  });

  it('muse logout 之後 providers 是空的 —— 檔案還在也算未登入', async () => {
    museFile = JSON.stringify({ schema_version: 1, providers: {} });
    const status = await probe();
    expect(status.muse).toMatchObject({ loggedIn: false, label: '未登入' });
  });

  it('OpenCode 自己沒憑證，但 app 存了金鑰就算能用', async () => {
    storedKeys.add('opencode');
    const status = await probe();
    expect(status.opencode).toMatchObject({ mode: 'api', label: 'API 金鑰' });
  });

  it('OpenCode 自己沒憑證、app 也沒金鑰就是未登入', async () => {
    const status = await probe();
    expect(status.opencode).toMatchObject({ loggedIn: false, label: '未登入' });
  });
});
