// npm run e2e:ssh 用：設好 MYTERMINAL_SSH_E2E 再叫 playwright。
// 走 node 而不是 shell 的 set / export，PowerShell 與 Git Bash 都能跑。
import { spawnSync } from 'node:child_process';

// 指令寫成一整串交給 shell：npx 在 Windows 上是 npx.cmd，
// Node 不允許不經 shell 直接 spawn .cmd。
const result = spawnSync('npx playwright test e2e/ssh.spec.ts', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MYTERMINAL_SSH_E2E: '1' },
});
process.exit(result.status ?? 1);
