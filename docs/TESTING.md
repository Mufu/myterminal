# 測試策略與測試回合紀錄

myterminal 的自動測試分四層，由便宜到昂貴。前三層不需要任何帳號；第四層會真的呼叫
`claude` / `codex`，用掉訂閱方案的額度（不是金錢，見 `docs/WORKFLOW.md` 的「用量與上限」）。

| 層 | 工具 | 跑什麼 | 指令 | 前置 |
|---|---|---|---|---|
| 1 單元 | Vitest（`environment: node`） | 邏輯層：SessionManager、ShellFactory、GraphCompiler、各 Store、畫布模型與手動操作的純函式、Command、驗證函式 | `npm test`、`npm run test:coverage` | 無 |
| 2 功能 e2e | Playwright `_electron` | 真的啟動 app 操作 UI：工作階段、工具列、對話框、畫布、主題、穩定性、打包版 | `npm run e2e` | 已 `npm run dist`（`packaged.spec` 用 `dist/win-unpacked`） |
| 3 環境 e2e | Playwright | SSH 登入、執行指令、離線 | `npm run e2e:ssh` | 本機 WSL sshd，見 README「本機 SSH 測試環境」 |
| 4 真實 CLI e2e | Playwright | Agent 任務、工作流範本、自訂工作流（條件 / 退回 / 逾時 / 取消 / Codex / 角色） | `npm run e2e:agent`、`npm run e2e:workflow`、`MYTERMINAL_WORKFLOW_E2E=1 npx playwright test e2e/workflow-custom.spec.ts` | 已登入的 `claude`、`codex` |

另外有一種不寫成 spec 的**探索性測試**：由 agent 拿一次性的 Playwright 腳本自由操作 app 找邊界問題，
只產出缺陷報告，不進 repo。2026-09-14 那一輪的腳本已經隨 worktree 刪除，發現的問題列在下面。

## 隔離原則

- 每個 spec 用自己的 `--user-data-dir`（`test-results/<spec>-user-data`，`e2e/helpers.ts` 的 `freshUserData()`），
  所以設定檔、工作流、主題、執行紀錄互不干擾，也不會碰到真正的 `%APPDATA%\myterminal`。
- 紀錄檔目錄用 `MYTERMINAL_LOG_DIR` 環境變數覆蓋（`toolbar.spec.ts` 用），預設仍是 `%USERPROFILE%\myterminal-logs`。
- Playwright 設定 `workers: 1`：一次只開一個 Electron。這台 16 GB 的機器同時跑兩個以上會不穩，
  `npm run dist` 也不要跟 e2e 同時跑。
- 每次 Playwright 執行都會先清空 `test-results/`。
- 工作目錄一律用真實長路徑，不要用 8.3 短路徑（`C:\Users\ROBERT~1\…`），無介面的 `claude` 會拒絕在那裡寫檔。
- 需要帳號或環境的 spec 用環境變數當開關（`MYTERMINAL_SSH_E2E`、`MYTERMINAL_AGENT_E2E`、
  `MYTERMINAL_AGENT_E2E_CODEX`、`MYTERMINAL_AGENT_E2E_OPENCODE`、`MYTERMINAL_WORKFLOW_E2E`），
  沒設就 `test.skip`。`MYTERMINAL_AGENT_E2E_OPENCODE` 那兩個只要網路：用的是免費模型
  `opencode/mimo-v2.5-free`（`MYTERMINAL_OPENCODE_MODEL` 指定）。

## e2e spec 一覽

| 檔案 | 案例 | 開關 | 涵蓋 |
|---|---|---|---|
| `smoke.spec.ts` | 1 | 無 | 新連接開 PowerShell 看到提示字元 |
| `packaged.spec.ts` | 1 | 無 | `dist/win-unpacked/myterminal.exe` 也開得出 PowerShell |
| `sessions.spec.ts` | 6 | 無 | 多工作階段切換與命名、WSL、自訂命令與離開碼、✕ 關閉、Claude / Codex 互動 TUI 起得來（不送提示） |
| `toolbar.spec.ts` | 6 | 無 | 輸入字多行送出、貼上、多行貼上依序執行、複製文字、紀錄檔內容與停止、清除畫面 |
| `dialogs.spec.ts` | 8 | 無 | SSH 空主機 / 埠 abc / 埠 70000、自訂命令空執行檔、Agent 任務空提示、取消永遠關得掉、Enter 等於建立、WSL 不存在的發行版不會讓 app 掛掉 |
| `robustness.spec.ts` | 4 | 無 | 視窗縮放到 500×300 再放大、連開 6 個再全關、執行中關視窗、輸入框按 Delete |
| `profiles.spec.ts` | 2 | 無 | 儲存連線、重啟後保留、點一下連線、刪除 |
| `theme.spec.ts` | 3 | 無 | 淺色、暖色、重啟後記得 |
| `editor.spec.ts` | 1 | 無 | 畫布拉一個流程、接線、存檔、出現在執行對話框 |
| `editor-deep.spec.ts` | 13 | 無 | 範本另存副本與刪除、換線、刪節點連帶清參照、Delete 在輸入框不刪節點、條件 / 批准屬性重啟後還在、驗證錯誤、儲存並執行、回終端機、未儲存確認、執行對話框驗證、工作目錄不存在的錯誤 |
| `editor-shell.spec.ts` | 2 | 無 | 節點的「手動操作」：開終端機（PowerShell 起在節點的工作目錄）、複製提示（角色前言 + 代好的提示）、開終端機並啟動 Claude（TUI 起得來、「輸入字」面板已填好但沒送出）；工作目錄代不出來時先問一次，取消就什麼都不開 |
| `editor-run.spec.ts` | 1 | `MYTERMINAL_AGENT_E2E_OPENCODE` | 畫布上的執行檢視：儲存並執行後留在畫布、卡片顯示執行中→完成、卡片的「輸出」切到節點的終端機、回畫布後覆蓋層還在、屬性面板的接手 / 看輸出、卡片上的批准。只要網路不要金鑰（OpenCode 免費模型） |
| `ssh.spec.ts` | 1 | `MYTERMINAL_SSH_E2E` | 登入本機 sshd、執行指令、離線 |
| `agent.spec.ts` | 4 | `MYTERMINAL_AGENT_E2E`（codex／opencode／muse 另需 `_CODEX`／`_OPENCODE`／`_MUSE`） | 四支 CLI 各跑一次 Agent 任務；claude／codex 還會接手。opencode 那個只要網路不要金鑰，muse 那個在開發機上跑不了（沒有 Meta 憑證） |
| `workflow.spec.ts` | 2 | `MYTERMINAL_WORKFLOW_E2E` | 範本跑到批准後完成；重啟後仍可批准 |
| `workflow-custom.spec.ts` | 6 | `MYTERMINAL_WORKFLOW_E2E` | 條件 + 批准退回、5 秒逾時且子行程被砍、取消、Codex 節點、角色進 CLI（節點與 Agent 任務） |

## 2026-09-14 測試回合

方式：兩個 agent 各在 git worktree 寫第 2、4 層的 spec 並執行，一個 agent 做探索性測試，
發現的問題彙整後由一個 agent 在 main 上用 TDD 修，最後由主控端重新跑整套。

**結果**：新增 44 個 e2e 案例，其中 41 個一開始就通過、3 個因產品缺陷失敗；探索性測試另外找出 16 個問題。
合計 27 個問題，22 個已修（每個都有對應的單元或 e2e 測試），5 個只記錄。

已修的：

| 問題 | 修法 |
|---|---|
| 輸入字多行送給 PowerShell 時中間的換行不會執行、貼上多行順序顛倒、貼 64 KB 要等 40 秒 | 輸入字與貼上都改走 xterm 的 `paste()`：換行正規化成 Enter，程式有開 bracketed paste（PSReadLine、bash、Claude Code 都有）時整段包起來送 |
| SSH 連接埠打 `abc` 靜默變 22 | 拿掉 `\|\| 22`；空白或非數字顯示「請輸入 1 到 65535 的連接埠」 |
| 連接埠超出範圍時「取消」關不掉對話框；在輸入框按 Enter 等於取消 | 取消按鈕 `formnovalidate`，確認按鈕改為表單的預設按鈕，表單 `novalidate` |
| 工作流節點設定沒驗證（空提示、空工作目錄、條件來源空白、壞的正規式、空名稱） | `validateWorkflow` 加規則，儲存時列出 |
| 工作目錄不存在時顯示 `spawn claude ENOENT` 或 `error code: 267` | 啟動前檢查，訊息改為「工作目錄不存在：…」；renderer 去掉 IPC 的錯誤包裝字串 |
| 按「退回」被標成紅色「失敗」 | 新狀態「已退回」，中性徽章 |
| 取消後節點狀態點是紅色 | 節點新狀態「已取消」 |
| 紀錄檔名用 UTC、路徑混用斜線 | 本地時間、`path.join`、`MYTERMINAL_LOG_DIR` 可覆蓋 |
| 儲存連線失敗（例如目錄唯讀）沒有任何提示 | 顯示錯誤 |
| 手動改壞的 `workflows.json` 項目讓畫布整個不畫 | 讀檔時做結構檢查，壞的跳過；語意錯誤（例如空提示）仍會列出讓人修 |
| 視窗沒有最小尺寸，縮小後「儲存」按不到 | `minWidth: 900, minHeight: 560` |
| 自訂命令參數只用空白切，引號會被拆開再加反斜線 | 支援雙引號的參數解析器 |
| 已結束的工作階段還能開紀錄，產生 0 byte 檔 | 按鈕停用、命令不啟動 |
| 畫布開著時按新連接看不到新的工作階段 | 建立成功後切回終端機畫面 |
| 新節點一直往右排到看不見 | 超過 x=1000 換下一列 |

只記錄、未改：

- 工作階段命名用全域計數器（`PowerShell 1`、`WSL 2`、`PowerShell 3`），不是每種類型各自編號。
- Codex 只回報 token 數不回報金額，所以 Codex 節點永遠沒有 `≈$`，用量上限對 Codex 無效。
- Electron 會忽略超過 260 字元的 `--user-data-dir`，靜默寫進真正的 `%APPDATA%\myterminal`。
- 鍵盤焦點進了終端機之後 Tab 出不來（終端機的正常行為，但沒有逃生鍵）。
- 已儲存連線同名會直接覆蓋，沒有確認（README 有寫明）。

**覆蓋率**（`npm run test:coverage`，v8）：語句約 57 %、分支約 92 %。低於 60 % 的幾乎都是只能靠 e2e 驗證的
renderer 檢視類別、`main.ts`、`ipc.ts`、preload，因為 Vitest 跑在 node 環境沒有 DOM；它們的行為由第 2 層覆蓋，
但 Playwright 跑的是打包後的 bundle，數字不會反映在 v8 報告裡。

**沒有自動化的**：SmartScreen 提示、NSIS 安裝版實際安裝（可用 `/S` 靜默安裝，但會改系統，這輪沒做）、
真實遠端 SSH 主機、DPI 縮放、`{{…}}` 樣板在執行時的替換只由單元測試驗證。
