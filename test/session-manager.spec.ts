import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { ShellFactory } from '../src/main/shell-factory';
import { FakePtySpawner } from './fakes/fake-pty';
import type { DataEvent, ExitEvent } from '../src/shared/ipc';
import type { SessionInfo } from '../src/shared/session';

let spawner: FakePtySpawner;
let manager: SessionManager;

beforeEach(() => {
  spawner = new FakePtySpawner();
  // schedule 注入成同步執行，讓「spawn 後送出啟動指令」在測試裡是決定性的。
  manager = new SessionManager(spawner, new ShellFactory((name) => name), (fn) => fn());
});

describe('SessionManager 建立工作階段', () => {
  it('用 ShellFactory 的規格 spawn，並回傳 running 狀態', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);

    expect(info.type).toBe('powershell');
    expect(info.state).toBe('running');
    expect(info.logging).toBe(false);
    expect(spawner.last().spec.file).toBe('powershell.exe');
    expect(spawner.last().cols).toBe(80);
    expect(spawner.last().rows).toBe(24);
  });

  it('自動產生遞增名稱，並可被 profile.name 覆寫', () => {
    expect(manager.create({ type: 'powershell' }, 80, 24).name).toBe('PowerShell 1');
    expect(manager.create({ type: 'wsl' }, 80, 24).name).toBe('WSL 2');
    expect(manager.create({ type: 'powershell', name: '打包用' }, 80, 24).name).toBe('打包用');
  });

  it('每個工作階段的 id 都不同', () => {
    const a = manager.create({ type: 'powershell' }, 80, 24);
    const b = manager.create({ type: 'powershell' }, 80, 24);
    expect(a.id).not.toBe(b.id);
  });

  it('發出 created 事件', () => {
    const seen: SessionInfo[] = [];
    manager.on('created', (info) => seen.push(info));
    manager.create({ type: 'powershell' }, 80, 24);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('PowerShell 1');
  });

  it('Claude 工作階段會在 spawn 後把啟動指令寫進 pty', () => {
    manager.create({ type: 'claude', baseShell: 'powershell' }, 80, 24);
    expect(spawner.last().writes).toEqual(['claude\r']);
  });

  it('沒有啟動指令的型別不會多寫任何東西', () => {
    manager.create({ type: 'powershell' }, 80, 24);
    expect(spawner.last().writes).toEqual([]);
  });
});

describe('SessionManager 轉送與控制', () => {
  it('把 pty 的輸出以 data 事件轉出去 (Observer)', () => {
    const events: DataEvent[] = [];
    manager.on('data', (e) => events.push(e));
    const info = manager.create({ type: 'powershell' }, 80, 24);

    spawner.last().emitData('PS D:\\> ');

    expect(events).toEqual([{ id: info.id, data: 'PS D:\\> ' }]);
  });

  it('write / resize 轉給對應的 pty', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);
    manager.write(info.id, 'dir\r');
    manager.resize(info.id, 120, 40);

    expect(spawner.last().writes).toEqual(['dir\r']);
    expect(spawner.last().resizes).toEqual([[120, 40]]);
  });

  it('對不存在的 id 操作不會丟例外', () => {
    expect(() => manager.write('nope', 'x')).not.toThrow();
    expect(() => manager.resize('nope', 80, 24)).not.toThrow();
    expect(() => manager.close('nope')).not.toThrow();
  });
});

describe('SessionManager 生命週期', () => {
  it('pty 結束時狀態轉成 exited 並保留在清單中', () => {
    const exits: ExitEvent[] = [];
    manager.on('exit', (e) => exits.push(e));
    const info = manager.create({ type: 'powershell' }, 80, 24);

    spawner.last().emitExit(1);

    expect(exits).toEqual([{ id: info.id, exitCode: 1 }]);
    const listed = manager.list()[0];
    expect(listed.state).toBe('exited');
    expect(listed.exitCode).toBe(1);
  });

  it('close 會 kill pty、移出清單並發出 closed', () => {
    const closed: string[] = [];
    manager.on('closed', (id) => closed.push(id));
    const info = manager.create({ type: 'powershell' }, 80, 24);

    manager.close(info.id);

    expect(spawner.last().killed).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(closed).toEqual([info.id]);
  });

  it('關閉已結束的工作階段不會重複 kill，也仍會移出清單', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);
    spawner.last().emitExit(0);

    manager.close(info.id);

    expect(spawner.last().killed).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('已結束的工作階段不再轉送 write / resize (pty 已關閉，再碰會丟例外)', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);
    const pty = spawner.last();
    pty.emitExit(0);

    manager.write(info.id, 'dir\r');
    manager.resize(info.id, 120, 40);

    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
  });

  it('不合法的尺寸不會送進 pty (FitAddon 在容器隱藏時會算出 0/NaN)', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);
    manager.resize(info.id, 0, 24);
    manager.resize(info.id, 80, -1);
    manager.resize(info.id, Number.NaN, 24);

    expect(spawner.last().resizes).toEqual([]);
  });

  it('list 依建立順序回傳所有工作階段', () => {
    const a = manager.create({ type: 'powershell' }, 80, 24);
    const b = manager.create({ type: 'wsl' }, 80, 24);
    expect(manager.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('setLogging 會反映在 list 的 logging 欄位上', () => {
    const info = manager.create({ type: 'powershell' }, 80, 24);
    manager.setLogging(info.id, true);
    expect(manager.list()[0].logging).toBe(true);
  });

  it('closeAll 會 kill 所有還在跑的工作階段', () => {
    manager.create({ type: 'powershell' }, 80, 24);
    manager.create({ type: 'wsl' }, 80, 24);

    manager.closeAll();

    expect(spawner.spawned.every((p) => p.killed)).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});
