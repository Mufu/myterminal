import { safeStorage } from 'electron';
import type { Cipher } from './cli-auth-store';

/**
 * 正式環境的 Cipher：Electron 的 safeStorage。
 * Windows 上底層是 DPAPI，加密後的東西只有這台機器的這個使用者解得開；
 * 存進 JSON 之前再轉成 base64，設定檔本身仍然是純文字可讀的 JSON。
 */
export function safeStorageCipher(): Cipher {
  return {
    encrypt: (plain) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('這台機器沒有可用的加密機制，不能儲存 API 金鑰');
      }
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
  };
}
