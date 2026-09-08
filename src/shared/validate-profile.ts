import type { ConnectionProfile } from './profile';

/**
 * 設定檔驗證：回傳錯誤訊息陣列，空陣列代表合法。
 * 放在 shared 讓對話框 (renderer) 與 main 用同一套規則。
 */
export function validateProfile(profile: ConnectionProfile): string[] {
  const errors: string[] = [];

  switch (profile.type) {
    case 'ssh':
      if (!profile.host.trim()) errors.push('請輸入主機位址');
      if (!profile.user.trim()) errors.push('請輸入使用者名稱');
      if (profile.port !== undefined && (profile.port < 1 || profile.port > 65535)) {
        errors.push('連接埠必須介於 1 到 65535');
      }
      break;

    case 'custom':
      if (!profile.file.trim()) errors.push('請輸入執行檔');
      break;

    case 'claude':
    case 'codex':
      // 省略代表用預設值 (claude / codex)；填了但只有空白才是錯的。
      if (profile.startupCommand !== undefined && !profile.startupCommand.trim()) {
        errors.push('請輸入啟動指令');
      }
      break;

    case 'powershell':
    case 'wsl':
      break;
  }

  return errors;
}
