import { homedir } from 'node:os';
import type { CliAuth, CliAuthStatus } from '../shared/cli-auth';
import { UNKNOWN_AUTH, parseClaudeAuth, parseCodexAuth } from '../shared/cli-auth';
import type { IProcessSpawner, ProcessSpec } from './process-spawner';

/** 探測是開機時做的，不能卡住啟動：十秒還沒回話就放棄。*/
const TIMEOUT_MS = 10_000;

/** cmd.exe 找不到要跑的命令時的離開碼。*/
const CMD_NOT_FOUND = 9009;

const MISSING: CliAuth = { loggedIn: false, mode: 'unknown', label: '找不到指令' };

/**
 * 開機問一次兩支 CLI 是怎麼登入的 —— 兩個命令都是唯讀的，也不花錢。
 * 走跟 agent 同一個 IProcessSpawner，所以測試用 FakeProcessSpawner 就驗得完。
 * 任何一邊失敗都只是那一邊變成「無法判斷」，這個函式不會 reject：
 * 金額要怎麼標示不值得讓 app 開不起來。
 */
export function probeCliAuth(spawner: IProcessSpawner): Promise<CliAuthStatus> {
  const cwd = homedir();
  return Promise.all([
    probe(spawner, { file: 'claude', args: ['auth', 'status'], cwd }, parseClaudeAuth),
    // codex 是 .cmd shim，一定要透過 cmd.exe /c (見 process-spawner.ts)。
    probe(
      spawner,
      { file: 'cmd.exe', args: ['/c', 'codex', 'login', 'status'], cwd },
      parseCodexAuth,
    ),
  ]).then(([claude, codex]) => ({ claude, codex }));
}

function probe(
  spawner: IProcessSpawner,
  spec: ProcessSpec,
  parse: (stdout: string) => CliAuth,
): Promise<CliAuth> {
  return new Promise<CliAuth>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const finish = (auth: CliAuth): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      resolve(auth);
    };

    const child = spawner.spawn(spec);
    handle = setTimeout(() => {
      child.kill();
      finish(UNKNOWN_AUTH);
    }, TIMEOUT_MS);

    child.onStdout((chunk) => {
      stdout += chunk;
    });
    child.onStderr((chunk) => {
      stderr += chunk;
    });
    child.onExit((exitCode) => {
      if (exitCode === 0) {
        // codex 把那一行印在 stderr (claude 是 stdout)，所以 stdout 是空的就看 stderr。
        finish(parse(stdout.trim() ? stdout : stderr));
        return;
      }
      // spawn 失敗是 ENOENT (見 NodeProcessSpawner)，cmd.exe 找不到命令則是 9009。
      finish(stderr.includes('ENOENT') || exitCode === CMD_NOT_FOUND ? MISSING : UNKNOWN_AUTH);
    });
  }).catch(() => UNKNOWN_AUTH);
}
