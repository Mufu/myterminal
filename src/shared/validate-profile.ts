import type { ConnectionProfile } from './profile';
import { findRole } from './roles';

/**
 * 設定檔驗證：回傳錯誤訊息陣列，空陣列代表合法。
 * 放在 shared 讓對話框 (renderer) 與 main 用同一套規則。
 * requireName：要把這筆連線存成設定檔時，名稱才是必填的 (設定檔以名稱為鍵)。
 */
export function validateProfile(profile: ConnectionProfile, requireName = false): string[] {
  const errors: string[] = [];

  if (requireName && !profile.name?.trim()) errors.push('儲存設定時必須填名稱');

  switch (profile.type) {
    case 'ssh':
      if (!profile.host.trim()) errors.push('請輸入主機位址');
      if (!profile.user.trim()) errors.push('請輸入使用者名稱');
      // 沒填或不是數字 (對話框收成 NaN) 都要擋下來，不能默默用預設的 22。
      if (profile.port === undefined || !Number.isFinite(profile.port)) {
        errors.push('請輸入 1 到 65535 的連接埠');
      } else if (profile.port < 1 || profile.port > 65535) {
        errors.push('連接埠必須介於 1 到 65535');
      }
      break;

    case 'custom':
      if (!profile.file.trim()) errors.push('請輸入執行檔');
      break;

    case 'claude':
    case 'codex':
    case 'muse':
    case 'opencode':
      // 省略代表用預設值 (就是 CLI 的名字)；填了但只有空白才是錯的。
      if (profile.startupCommand !== undefined && !profile.startupCommand.trim()) {
        errors.push('請輸入啟動指令');
      }
      // Muse Code 只有 Linux 版，裝在 WSL 裡；PowerShell 起不來。
      if (profile.type === 'muse' && profile.baseShell !== 'wsl') {
        errors.push('Muse 只能在 WSL 裡執行');
      }
      break;

    case 'agent':
      // 工作目錄可以留空 (SessionManager 會用家目錄)，但沒有任務就沒事可做。
      if (!profile.prompt.trim()) errors.push('請輸入任務內容');
      if (profile.role !== undefined && !findRole(profile.role)) {
        errors.push(`角色不存在：${profile.role}`);
      }
      break;

    case 'powershell':
    case 'wsl':
      break;
  }

  return errors;
}
