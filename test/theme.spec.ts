import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeStore, THEMES, THEME_KEY, parseTheme } from '../src/renderer/theme';
import type { ThemeName, ThemeStorage } from '../src/renderer/theme';

/** 只有 getItem / setItem 的假 Storage，剛好是 ThemeStore 需要的介面。*/
class FakeStorage implements ThemeStorage {
  constructor(public readonly items = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

let storage: FakeStorage;
let applied: ThemeName[];
const store = (): ThemeStore => new ThemeStore(storage, (name) => applied.push(name));

beforeEach(() => {
  storage = new FakeStorage();
  applied = [];
});

describe('主題定義', () => {
  it('三種主題都有中文名稱與 xterm 主題', () => {
    expect(Object.keys(THEMES)).toEqual(['dark', 'light', 'warm']);
    for (const name of Object.keys(THEMES) as ThemeName[]) {
      expect(THEMES[name].name).toBe(name);
      expect(THEMES[name].label).toMatch(/色$/);
      expect(THEMES[name].terminal.background).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('parseTheme', () => {
  it('認得三個合法名稱', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('warm')).toBe('warm');
  });

  it('沒有或不認得的值一律回深色', () => {
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('')).toBe('dark');
    expect(parseTheme('solarized')).toBe('dark');
  });
});

describe('ThemeStore', () => {
  it('沒有存過時預設深色，並在建構時套用', () => {
    expect(store().get()).toBe('dark');
    expect(applied).toEqual(['dark']);
  });

  it('讀回存過的主題', () => {
    storage.setItem(THEME_KEY, 'warm');
    expect(store().get()).toBe('warm');
    expect(applied).toEqual(['warm']);
  });

  it('存的值壞掉時退回深色', () => {
    storage.setItem(THEME_KEY, 'neon');
    expect(store().get()).toBe('dark');
    expect(applied).toEqual(['dark']);
  });

  it('set 會套用、寫進 storage 並通知訂閱者', () => {
    const s = store();
    let notified = 0;
    s.subscribe(() => (notified += 1));

    s.set('light');

    expect(s.get()).toBe('light');
    expect(applied).toEqual(['dark', 'light']);
    expect(storage.getItem(THEME_KEY)).toBe('light');
    expect(notified).toBe(1);
  });

  it('設成同一個主題不會重複通知', () => {
    const s = store();
    let notified = 0;
    s.subscribe(() => (notified += 1));
    s.set('dark');
    expect(notified).toBe(0);
    expect(applied).toEqual(['dark']);
  });

  it('unsubscribe 之後不再收到通知', () => {
    const s = store();
    let notified = 0;
    const off = s.subscribe(() => (notified += 1));
    off();
    s.set('warm');
    expect(notified).toBe(0);
  });
});
