import type { ITheme } from '@xterm/xterm';

/**
 * 三種主題。CSS 那邊靠 html[data-theme] 換掉一整組 custom property，
 * 這裡只負責「現在是哪一個、記在哪、換的時候通知誰」，以及 xterm.js 需要的顏色
 * （xterm 的畫布不吃 CSS 變數，只能用 JS 給 ITheme）。
 */

export type ThemeName = 'dark' | 'light' | 'warm';

export interface ThemeMeta {
  name: ThemeName;
  /** 下拉選單上的名稱 */
  label: string;
  terminal: ITheme;
}

export const THEMES: Record<ThemeName, ThemeMeta> = {
  dark: {
    name: 'dark',
    label: '深色',
    terminal: {
      background: '#0c0f12',
      foreground: '#cfd3d7',
      cursor: '#cfd3d7',
      cursorAccent: '#0c0f12',
      selectionBackground: 'rgba(107, 177, 239, 0.28)',
    },
  },
  light: {
    name: 'light',
    label: '淺色',
    terminal: {
      background: '#181b1f',
      foreground: '#d1d5d9',
      cursor: '#d1d5d9',
      cursorAccent: '#181b1f',
      selectionBackground: 'rgba(0, 103, 192, 0.32)',
    },
  },
  warm: {
    name: 'warm',
    label: '暖色',
    terminal: {
      background: '#14100b',
      foreground: '#d8d3ca',
      cursor: '#e5ab60',
      cursorAccent: '#14100b',
      selectionBackground: 'rgba(229, 171, 96, 0.26)',
    },
  },
};

export const THEME_KEY = 'myterminal.theme';

/** localStorage 只用得到這兩個方法，測試就不必造一整個 Storage。*/
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 不認得的值 (沒存過、手動改壞、舊版本留下的) 一律回深色。*/
export function parseTheme(value: unknown): ThemeName {
  return value === 'light' || value === 'warm' || value === 'dark' ? value : 'dark';
}

type Listener = () => void;

/** ThemeStore：跟 AppState 一樣的 Observer，多了持久化。*/
export class ThemeStore {
  private readonly listeners = new Set<Listener>();
  private current: ThemeName;

  constructor(
    private readonly storage: ThemeStorage = window.localStorage,
    private readonly apply: (name: ThemeName) => void = (name) => {
      document.documentElement.dataset.theme = name;
    },
  ) {
    this.current = parseTheme(this.storage.getItem(THEME_KEY));
    this.apply(this.current);
  }

  get(): ThemeName {
    return this.current;
  }

  set(name: ThemeName): void {
    if (name === this.current) return;
    this.current = name;
    this.storage.setItem(THEME_KEY, name);
    this.apply(name);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
