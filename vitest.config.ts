import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑單元測試；E2E 由 Playwright 負責 (e2e/)
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
});
