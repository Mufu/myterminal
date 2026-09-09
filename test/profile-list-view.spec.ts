import { describe, it, expect } from 'vitest';
import { profileMeta } from '../src/renderer/profile-list-view';
import { sessionTag } from '../src/renderer/session-list-view';
import type { SessionInfo } from '../src/shared/session';

describe('profileMeta', () => {
  it('SSH 顯示 user@host', () => {
    expect(profileMeta({ type: 'ssh', name: 'a', host: 'build-server', user: 'deploy' })).toBe(
      'deploy@build-server',
    );
  });

  it('WSL 顯示發行版，沒填就沒有 meta', () => {
    expect(profileMeta({ type: 'wsl', name: 'a', distro: 'Ubuntu' })).toBe('Ubuntu');
    expect(profileMeta({ type: 'wsl', name: 'a' })).toBe('');
  });

  it('Claude / Codex 顯示啟動指令，省略時是預設值', () => {
    expect(
      profileMeta({ type: 'claude', name: 'a', baseShell: 'powershell', startupCommand: 'claude -c' }),
    ).toBe('claude -c');
    expect(profileMeta({ type: 'codex', name: 'a', baseShell: 'powershell' })).toBe('codex');
  });

  it('自訂命令顯示執行檔', () => {
    expect(profileMeta({ type: 'custom', name: 'a', file: 'cmd.exe' })).toBe('cmd.exe');
  });

  it('PowerShell 沒有 meta', () => {
    expect(profileMeta({ type: 'powershell', name: 'a' })).toBe('');
  });
});

describe('sessionTag', () => {
  const info = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 's1',
    name: 'x',
    type: 'powershell',
    state: 'running',
    logging: false,
    ...over,
  });

  it('一般型別就是型別名稱', () => {
    expect(sessionTag(info({ type: 'ssh' }))).toBe('SSH');
  });

  it('agent 任務要看得出是哪個 CLI', () => {
    expect(sessionTag(info({ type: 'agent', agentKind: 'claude' }))).toBe('Claude 任務');
    expect(sessionTag(info({ type: 'agent', agentKind: 'codex' }))).toBe('Codex 任務');
  });
});
