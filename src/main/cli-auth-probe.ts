import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAuth, CliAuthStatus, CliId } from '../shared/cli-auth';
import {
  UNKNOWN_AUTH,
  parseClaudeAuth,
  parseCodexAuth,
  parseMuseAuth,
  parseOpencodeAuth,
} from '../shared/cli-auth';
import type { IProcessSpawner, ProcessSpec } from './process-spawner';

/** 探測是開機時做的，不能卡住啟動：十秒還沒回話就放棄。*/
const TIMEOUT_MS = 10_000;

/** cmd.exe 找不到要跑的命令時的離開碼。*/
const CMD_NOT_FOUND = 9009;

const MISSING: CliAuth = { loggedIn: false, mode: 'unknown', label: '找不到指令' };

/** Muse 存憑證的地方；Windows 與 WSL 都是家目錄底下的同一條相對路徑。*/
export const museAuthPath = (): string => join(homedir(), '.config', 'muse', 'auth.json');

/** 讀 Muse 憑證檔的縫線：讀不到 (還沒登入過) 回傳 null。*/
export type FileReader = (path: string) => string | null;

const defaultReader: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * 開機問一次四支 CLI 是怎麼登入的 —— 這些命令都是唯讀的，也不花錢。
 * 走跟 agent 同一個 IProcessSpawner，所以測試用 FakeProcessSpawner 就驗得完。
 * 任何一邊失敗都只是那一邊變成「無法判斷」，這個函式不會 reject：
 * 金額要怎麼標示不值得讓 app 開不起來。
 */
export function probeCliAuth(
  spawner: IProcessSpawner,
  /** app 自己存了哪些金鑰；OpenCode 沒有登入流程，有金鑰就算能用。*/
  hasStoredKey: (id: CliId) => boolean = () => false,
  readFile: FileReader = defaultReader,
): Promise<CliAuthStatus> {
  const cwd = homedir();
  return Promise.all([
    probe(spawner, { file: 'claude', args: ['auth', 'status'], cwd }, parseClaudeAuth),
    // codex / muse / opencode 都是 .cmd shim，一定要透過 cmd.exe /c (見 process-spawner.ts)。
    probe(spawner, { file: 'cmd.exe', args: ['/c', 'codex', 'login', 'status'], cwd }, parseCodexAuth),
    // Muse 沒有「看登入狀態」的指令，所以先用 --version 確認裝了沒有，
    // 再讀它存憑證的檔案判斷是帳號登入還是 API 金鑰。
    // --version 本身不會失敗，所以只要不是 0 就是沒裝 —— cmd.exe 找不到命令的
    // 離開碼跟 Windows 語系有關 (這台繁中機器是 1，不是 9009)，不能只靠 9009。
    probe(
      spawner,
      { file: 'cmd.exe', args: ['/c', 'muse', '--version'], cwd },
      () => parseMuseAuth(readFile(museAuthPath())),
      true,
    ),
    probe(spawner, { file: 'cmd.exe', args: ['/c', 'opencode', 'auth', 'list'], cwd }, (stdout) =>
      parseOpencodeAuth(stdout, hasStoredKey('opencode')),
    ),
  ]).then(([claude, codex, muse, opencode]) => ({ claude, codex, muse, opencode }));
}

function probe(
  spawner: IProcessSpawner,
  spec: ProcessSpec,
  parse: (stdout: string) => CliAuth,
  /** 這個命令跑不起來就等於「沒裝」(只有拿來確認存在的 muse --version 是這樣)。*/
  missingOnFailure = false,
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
      const missing =
        missingOnFailure || stderr.includes('ENOENT') || exitCode === CMD_NOT_FOUND;
      finish(missing ? MISSING : UNKNOWN_AUTH);
    });
  }).catch(() => UNKNOWN_AUTH);
}
