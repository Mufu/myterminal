// npm run e2e:agent 用：設好 MYTERMINAL_AGENT_E2E 再叫 playwright。
// 走 node 而不是 shell 的 set / export，PowerShell 與 Git Bash 都能跑。
// 注意：這個測試會真的呼叫 claude / codex，要先登入而且會產生費用。
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx playwright test e2e/agent.spec.ts', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MYTERMINAL_AGENT_E2E: '1' },
});
process.exit(result.status ?? 1);
