import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑單元測試；E2E 由 Playwright 負責 (e2e/)
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      // 預設只算「測試載入過」的檔案，完全沒測到的會看不見，所以把整個 src 都算進來。
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
