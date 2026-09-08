import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Electron 冷啟動 + PowerShell 起來需要一點時間。
  timeout: 60_000,
  reporter: [['list']],
  workers: 1,
});
