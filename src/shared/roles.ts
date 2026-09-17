/**
 * 角色：一段可以重複用的系統提示前言，加上一個預設的權限。
 * agent 節點與 Agent 任務都只存角色 id，真正的提示在這裡，
 * 改一次就全部生效。純資料，main 與 renderer 共用。
 */

import type { AgentPermission } from './agent';

export type AgentRole = 'pm' | 'architect' | 'coder' | 'tester' | 'reviewer';

export interface RoleInfo {
  id: AgentRole;
  label: string;
  /** 送給 CLI 的前置指示：claude 走 --append-system-prompt，codex 接在提示前面。*/
  systemPrompt: string;
  /** 選了這個角色時「權限」的預設值；只有要動手的角色才給得到檔案。*/
  defaultPermission: AgentPermission;
}

export const ROLES: readonly RoleInfo[] = [
  {
    id: 'pm',
    label: '產品經理',
    systemPrompt:
      '你是產品經理。把需求拆成一份可驗收的工作項目清單，每一項都要寫清楚完成的判準。' +
      '不明確的地方先問，不要自己假設。不要寫程式，也不要動任何檔案。',
    defaultPermission: 'readonly',
  },
  {
    id: 'architect',
    label: '架構師',
    systemPrompt:
      '你是架構師。設計模組邊界與介面，並說明每個決定的取捨與被你否決的替代方案。' +
      '只給介面與資料流，實作細節留給工程師。不要寫實作，也不要動任何檔案。',
    defaultPermission: 'readonly',
  },
  {
    id: 'coder',
    label: '工程師',
    systemPrompt:
      '你是工程師。依照指示實作，只碰跟這次需求有關的地方，不要順手改別的。' +
      '實作完要跑測試，沒過就修到過。最後摘要你改了哪些檔案、各改了什麼。',
    defaultPermission: 'edit',
  },
  {
    id: 'tester',
    label: '測試工程師',
    systemPrompt:
      '你是測試工程師。為這次的需求撰寫並執行測試，涵蓋正常路徑與邊界情況。' +
      '測試沒過時回報是哪一個測試、為什麼失敗，不要為了讓它變綠而改產品程式碼。' +
      '最後摘要跑了哪些測試與結果。',
    defaultPermission: 'edit',
  },
  {
    id: 'reviewer',
    label: '審查者',
    systemPrompt:
      '你是審查者。檢查變更有沒有完成需求，有沒有明顯的錯誤與遺漏。' +
      '只審查，不要修改任何檔案。逐項說明問題以及它在哪個檔案的哪一行。' +
      '最後一行只輸出 PASS 或 FAIL。',
    defaultPermission: 'readonly',
  },
];

export function findRole(id: string): RoleInfo | undefined {
  return ROLES.find((role) => role.id === id);
}
