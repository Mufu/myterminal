import { describe, it, expect } from 'vitest';
import { ShellFactory } from '../src/main/shell-factory';

/**
 * ShellFactory 是 Factory Method：把 ConnectionProfile 轉成 spawn 規格。
 * 測試時注入假的 resolver，避免依賴這台機器上真的有 plink / wsl。
 */
const resolver = (name: string) => `RESOLVED(${name})`;
const factory = new ShellFactory(resolver);

describe('ShellFactory', () => {
  it('PowerShell 用 -NoLogo 啟動並帶入 cwd', () => {
    const spec = factory.create({ type: 'powershell', cwd: 'D:/work' });
    expect(spec.file).toBe('RESOLVED(powershell.exe)');
    expect(spec.args).toEqual(['-NoLogo']);
    expect(spec.cwd).toBe('D:/work');
    expect(spec.startupCommand).toBeUndefined();
  });

  it('WSL 帶 distro 與 --cd，不把 Linux 路徑當成 Windows cwd', () => {
    const spec = factory.create({ type: 'wsl', distro: 'Ubuntu', cwd: '/home/robert' });
    expect(spec.file).toBe('RESOLVED(wsl.exe)');
    expect(spec.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/robert']);
    expect(spec.cwd).toBeUndefined();
  });

  it('WSL 沒指定 distro / cwd 時不加多餘參數', () => {
    const spec = factory.create({ type: 'wsl' });
    expect(spec.args).toEqual([]);
  });

  it('SSH 組出 plink 參數，未指定 port 時用 22', () => {
    const spec = factory.create({ type: 'ssh', host: 'example.com', user: 'robert' });
    expect(spec.file).toBe('RESOLVED(plink.exe)');
    expect(spec.args).toEqual(['-ssh', '-P', '22', 'robert@example.com']);
  });

  it('SSH 使用自訂 port', () => {
    const spec = factory.create({ type: 'ssh', host: 'h', user: 'u', port: 2222 });
    expect(spec.args).toEqual(['-ssh', '-P', '2222', 'u@h']);
  });

  it('Claude 以 PowerShell 為基礎 shell，並帶出啟動指令', () => {
    const spec = factory.create({ type: 'claude', baseShell: 'powershell', cwd: 'D:/repo' });
    expect(spec.file).toBe('RESOLVED(powershell.exe)');
    expect(spec.args).toEqual(['-NoLogo']);
    expect(spec.cwd).toBe('D:/repo');
    expect(spec.startupCommand).toBe('claude');
  });

  it('Codex 可以跑在 WSL 上，且啟動指令可被覆寫', () => {
    const spec = factory.create({
      type: 'codex',
      baseShell: 'wsl',
      startupCommand: 'codex --model o3',
    });
    expect(spec.file).toBe('RESOLVED(wsl.exe)');
    expect(spec.startupCommand).toBe('codex --model o3');
  });

  it('自訂命令原樣傳出', () => {
    const spec = factory.create({ type: 'custom', file: 'cmd.exe', args: ['/k', 'dir'] });
    expect(spec.file).toBe('RESOLVED(cmd.exe)');
    expect(spec.args).toEqual(['/k', 'dir']);
  });

  it('自訂命令沒給 args 時是空陣列', () => {
    const spec = factory.create({ type: 'custom', file: 'notepad.exe' });
    expect(spec.args).toEqual([]);
  });

  it('每個規格都帶 TERM 讓 xterm.js 收到正確的跳脫序列', () => {
    const spec = factory.create({ type: 'powershell' });
    expect(spec.env.TERM).toBe('xterm-256color');
  });
});
