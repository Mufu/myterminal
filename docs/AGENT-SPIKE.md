# Agent 任務 spike：決策文件

**目的**：在 Windows 上實測 `claude` 與 `codex` 能不能用「無介面 + 結構化輸出」的方式
被程式驅動，把一次執行當成普通的工作階段顯示，並且讓人隨時接手。
結論要能回答一個問題：**下一步要不要引進 LangGraph 之類的編排層。**

實測日期 2026-09-09，機器是 Windows 11 Enterprise LTSC 2024 (26100)，
`claude` 2.1.265（`%USERPROFILE%\.local\bin\claude.exe`）、
`codex-cli` 0.142.2（`%APPDATA%\npm\codex.cmd`）。

這份文件只記錄**實際跑出來的東西**；沒跑到的地方都會標明。

## 1. 實際用的命令

程式裡組出來的命令（`src/main/agent-runner.ts`），提示一律走 **stdin**：

| 情境 | 命令 |
| --- | --- |
| Claude，不給改檔案 | `claude -p --output-format stream-json --verbose --permission-mode plan` |
| Claude，允許改檔案 | 同上，`--permission-mode acceptEdits` |
| Claude，接續 | 同上再加 `--resume <session_id>` |
| Codex，不給改檔案 | `cmd.exe /c codex exec --sandbox read-only --json --skip-git-repo-check -c approval_policy="never"` |
| Codex，允許改檔案 | 同上，`--sandbox workspace-write` |
| Codex，接續 | `cmd.exe /c codex exec resume <thread_id> -c sandbox_mode="read-only" --json --skip-git-repo-check -c approval_policy="never"` |
| 人接手（互動式） | `claude --resume <session_id>` ／ `codex resume <thread_id>` |

工作目錄是 spawn 的 `cwd`（Codex 另有 `-C`，但沒必要重複指定；`exec resume` 也不吃 `-C`）。

## 2. 觀察到的事件形狀

### Claude：`-p --output-format stream-json --verbose`

原始輸出留在 [`test/fixtures/claude-stream-json.jsonl`](../test/fixtures/claude-stream-json.jsonl)
（純文字問答）與 [`claude-stream-json-tools.jsonl`](../test/fixtures/claude-stream-json-tools.jsonl)
（`--resume` + 用了 Read 工具），一個字都沒有刪。四種行：

```jsonc
{"type":"system","subtype":"init","cwd":"…","session_id":"a7c9c5c6-…","tools":[…],
 "model":"claude-opus-5[1m]","permissionMode":"default","claude_code_version":"2.1.265", …}

{"type":"rate_limit_event","rate_limit_info":{"status":"allowed", …},"session_id":"a7c9c5c6-…"}

{"type":"assistant","message":{"content":[{"type":"text","text":"AGENT_SPIKE_OK"}],
 "usage":{…}},"session_id":"a7c9c5c6-…","uuid":"…","timestamp":"…"}

{"duration_api_ms":3412,"session_id":"a7c9c5c6-…","total_cost_usd":0.0748045,"usage":{…},
 "is_error":false,"num_turns":1,"subtype":"success","result":"AGENT_SPIKE_OK",
 "type":"result","duration_ms":2664, …}
```

工具事件長這樣（`assistant` 的 content 裡，下一行會有一個 `user` + `tool_result`）：

```jsonc
{"type":"tool_use","id":"toolu_01Jz…","name":"Read",
 "input":{"file_path":"C:\\…\\hello.txt"},"caller":{"type":"direct"}}
```

**注意**：`result` 那一行的 `"type":"result"` 出現在物件的**中後段**，
不是第一個 key。任何「看開頭是不是 `{"type":"result"`」的判斷都會漏掉它，
一定要真的 `JSON.parse`。

### Codex：`exec --json`

原始輸出留在 [`test/fixtures/codex-exec-json.jsonl`](../test/fixtures/codex-exec-json.jsonl)。
**這是一次失敗的執行**（原因見第 5 節），所以只有錯誤路徑是實測過的：

```jsonc
{"type":"thread.started","thread_id":"01a08436-5df0-7771-8b1e-3542567d3dc7"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: …)"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets…"}}
{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: The model `gpt-5.5` does not exist…"}}
```

頂層的 `{"type":"error"}` 是**傳輸層重試的雜訊**：一次失敗會印五行，換傳輸方式再印五行。
真正的原因在最後的 `turn.failed` 裡，所以 `codexEvents` 不轉送頂層 `error`。

成功路徑（`item.completed` 的 `agent_message` / `command_execution` / `file_change`
與收尾的 `turn.completed`）**沒有實測到**，是照 `codex exec --json` 的結構寫的，
在 `test/agent-runner.spec.ts` 裡有註明。

## 3. 延遲、費用、離開碼

| 執行 | 牆鐘 | CLI 自報 | 費用 | exit |
| --- | --- | --- | --- | --- |
| Claude，`只回覆 AGENT_SPIKE_OK`（預設權限） | 7.7 s | `duration_ms` 2664、`ttft_ms` 2570 | $0.0748 | 0 |
| Claude，`--resume` + 讀一個檔 | 10.7 s | `duration_ms` 5284（`num_turns` 2） | $0.0265 | 0 |
| Claude，`--permission-mode plan` | 16.0 s | `duration_ms` 8979 | $0.0909 | 0 |
| Claude，app 裡跑（`e2e/agent.spec.ts`） | 約 13 s（含 Electron 冷啟動） | 頁尾顯示 2.4–3.6 s | $0.091 | 0 |
| Codex，預設模型 | 87.5 s（重試 2×5 次） | — | — | 1 |

**牆鐘比 CLI 自報的久 2～5 秒**：那是 CLI 自己啟動（Node、設定、MCP 探測）的時間，
編排層估時要算進去。

> 上面表格裡的 `$` 是 CLI 自報的 `total_cost_usd`。這台機器是訂閱登入，
> 所以那些數字是 API 等值的**估算**，見文末的「2026-09-14 更新」。

費用要注意：這台機器 `claude` 的預設模型是 opus-5，
一句「只回覆 OK」也要 **$0.07～0.09** —— 幾乎全部是冷啟動時建立 prompt cache 的錢
（`cache_creation_input_tokens` 6576，輸出只有 15 tokens）。
接續同一個 session 就便宜很多（$0.027）。

## 4. 接續（resume）

- **Claude**：`claude -p --resume <session_id>` 實測可用。`session_id` **不變**，
  `num_turns` 從 1 變 2，上下文有留著。`--fork-session` 可以改成產生新 id（沒測）。
- **Codex**：`codex exec resume <thread_id> [prompt]` 與互動式的 `codex resume <thread_id>`
  都存在（`--help` 確認過），但因為拿不到模型，**沒有實際跑成功過**。

「接手」用的是互動式那一支：右側清單的按鈕會用既有的 Claude / Codex 工作階段型別
開一個 PowerShell，再送 `claude --resume <id>`。實測 Claude 這條路可以接上
（`e2e/agent.spec.ts` 會斷言接手後的終端機出現 Claude 的介面）。

## 5. Codex 在這台機器上跑不起來

> 2026-09-14 已經不是這樣了，見文末的「2026-09-14 更新」。這一節留著原樣。

`codex login status` 是 `Logged in using ChatGPT`，但設定裡的模型 `gpt-5.5` 回：

```
unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.
```

試過 `gpt-5.1`、`gpt-5.1-codex`、`gpt-5.1-codex-max`、`gpt-5-codex`，全部回
`The '<model>' model is not supported when using Codex with a ChatGPT account.`
`~/.codex/models_cache.json` 裡也只有 `gpt-5.5`。
`~/.codex/sessions/` 只有今天這幾次失敗紀錄，代表這台機器從來沒成功跑過 codex。

**所以 Codex 這半只驗證到「命令組得出來、行程跑得起來、事件解析得了、失敗會正確收尾」，
沒有驗證到成功路徑。** `e2e/agent.spec.ts` 的 codex 測試預設 skip，
帳號能用之後設 `MYTERMINAL_AGENT_E2E_CODEX=1` 就會跑。

值得一提的是，失敗路徑在 app 裡的表現是對的：

```
[codex] 任務：只回覆 AGENT_E2E_OK，不要做別的事
✘ 失敗：unexpected status 404 Not Found: The model `gpt-5.5` does n… · session 01a0845e…
[工作階段已結束]
```

## 6. Windows 的坑

| 坑 | 細節 |
| --- | --- |
| **`codex` 是 `.cmd` shim** | `spawn('codex')` 不經 shell → `ENOENT`；`spawn('…\\codex.cmd')` → `EINVAL`（Node 修 CVE-2024-27980 之後不准直接 spawn 批次檔）；`shell: true` 可以，但會跳 `DEP0190` 而且參數是**直接串接不跳脫**。最後選 `cmd.exe /c codex …`：參數仍由 Node 負責跳脫。`claude` 是真的 `.exe`，`spawn('claude')` 直接可用。 |
| **提示走 stdin** | 兩個 CLI 沒有位置參數時都會讀 stdin。中文、多行、引號全部不必處理。Codex 會往 **stderr** 印一行 `Reading prompt from stdin...`（那不是錯誤）。 |
| **`--verbose` 是必要的** | `claude -p --output-format stream-json` 少了 `--verbose` 會直接 exit 1：`Error: When using --print, --output-format=stream-json requires --verbose`。這發生在打 API 之前，不花錢。 |
| **`--skip-git-repo-check`** | 在不是 git repo 也沒被信任的目錄裡，`codex exec` 會 exit 1：`Not inside a trusted directory and --skip-git-repo-check was not specified.` |
| **離開碼晚於終端事件** | `result` / `turn.failed` 那一行比行程結束早到，所以 `AgentEvent.result.exitCode` 是在 `close` 時才補上的（`JsonlRun.finish`）。 |
| **`codex -c` 不能覆寫內建 provider** | `-c model_providers.openai.…` 會 exit 1（`reserved built-in provider IDs`）。想調重試次數得換別的做法。 |
| **`codex exec resume` 的旗標比較少** | 沒有 `--sandbox` / `-C` / `-m`，沙箱只能用 `-c sandbox_mode="…"` 設。 |
| **`claude --max-turns`** | 2.1.265 的 `--help` 裡**看不到**這個旗標，但傳進去仍然 exit 0（隱藏選項）。因為沒有出現在 help 上，這個 spike 不用它。 |
| **輸出要換成 CRLF** | CLI 給的是 `\n`，xterm.js 要 `\r\n`，在 `AgentRunPty` 轉。 |

順帶修掉兩個本來就在、被 agent 放大的 renderer 順序問題（見 commit `384df4e`）：
`session:data` 可能比 `session:create` 的回覆早到（第一行標題會被丟掉），
`session:changed` 也可能比回覆晚到（剛建好的終端機會被 `syncTerminals()` 清掉）。

## 7. LangGraph（或任何編排層）會呼叫什麼

這個 spike 刻意把介面切在「一次執行」上：

```ts
const run = runners(kind).start({ kind, prompt, cwd, allowEdits, resumeId });
run.onEvent((event) => { /* init / text / tool / result / error */ });
run.cancel();
```

一個節點要的東西就是最後那個 `result`：

```ts
{ type: 'result', ok, text, sessionId, durationMs?, costUsd?, exitCode }
```

- **節點的輸出** = `text`（成功）或 `error` / `result.ok === false` 的訊息。
- **狀態的接續** = 把 `sessionId` 存進 graph state，下一個節點用 `resumeId` 傳回去。
- **中止** = `cancel()`（實測會 kill 行程）。
- **成本與時間** = `costUsd` / `durationMs`，可以直接累加成預算控制。

也就是說，編排層不需要知道 CLI、旗標、JSONL、Windows 的 `.cmd` 這些事，
`IAgentRunner` 就是那道界線。`AgentRunPty` 是另一個方向的轉接（給人看的那一面），
兩者互不相干。

## 8. 還沒解決的風險

1. **權限**：`allowEdits` 現在只有兩檔（Claude `plan` / `acceptEdits`，
   Codex `read-only` / `workspace-write`）。`acceptEdits` 是**真的會改檔案**，
   而且 Claude 仍可能執行 Bash。要跑不受信任的任務之前得先想清楚沙箱。
2. **費用**：opus-5 + 冷啟動 = 每次約 $0.09，跟任務大小幾乎無關。
   編排層如果一次開十個節點，那是 $1 起跳。`--max-budget-usd` 或換模型要先決定。
3. **格式漂移**：`rate_limit_event` 這種行沒有出現在文件上；`result` 的 key 順序也不固定。
   解析器對未知的 `type` 一律忽略、對壞行一律跳過，就是為了這個。
   但**欄位改名**（例如 `total_cost_usd`）會靜默地讓費用變成 `undefined`，
   fixture 測試只能擋住「我們看過的那一版」。
4. **Codex 沒驗到成功路徑**（第 5 節）。
5. **沒有追問**：`AgentRunPty.write()` 是 no-op，人只能「接手」到互動式工作階段去問。
   要在 app 裡直接追問，得走 `--input-format stream-json` 那條路，是另一個題目。
6. **沒有逾時**：CLI 卡住的話這裡會一直等。Codex 那次失敗就卡了 87 秒；
   真的編排要自己設上限。

## 9. 建議

**可以往下走，但先不要急著把 LangGraph 搬進來。** 這個 spike 證明了三件事：
兩個 CLI 都能用結構化輸出被程式驅動（Claude 完全驗證，Codex 只驗到失敗路徑）、
一次執行可以完全不動 `SessionManager` 就變成畫面上的一個工作階段、
以及人可以隨時接手同一段對話 —— 也就是說，「agent 是一種工作階段」這個抽象成立，
而 `IAgentRunner` 這道界線夠窄，窄到編排層只需要 `start` / `onEvent` / `cancel`。
真正還沒解決的不是編排（那是 LangGraph 的強項），而是**費用、權限與逾時**這三件事：
它們在單一節點上就已經是問題，先用一條直線的「兩三步任務」把這三件事釘死
（每步的預算上限、edits 的預設、卡住怎麼辦），再決定要不要引進圖狀編排。
如果那時候需要的只是「依序跑、失敗重試」，`IAgentRunner` 加一個迴圈就夠了；
要到分支、平行、人工介入節點才值得付 LangGraph 的抽象成本。
另外，Codex 這半在帳號能用之前都只能算「理論上可行」，
不要把編排層設計成假設兩個 CLI 對等。

## 2026-09-14 更新

這份 spike 之後有兩件事變了。

**Codex 跑得起來了。** 同一台機器、同一版 `codex-cli` 0.142.2、同一個模型 `gpt-5.5`，
但這次 ChatGPT 訂閱拿得到它。`MYTERMINAL_AGENT_E2E_CODEX=1 npm run e2e:agent` 整條路徑
（app → `cmd.exe /c codex exec --json` → 事件解析 → 畫面）跑完是綠的，一次大約兩分鐘。
所以第 5 節的「只驗證到失敗路徑」不再成立 —— 成功路徑也驗過了，
命令、事件形狀與收尾方式都跟當初寫的一樣，一行程式都不用改。

**兩支 CLI 都是訂閱登入，所以這份文件裡的 `$` 全部是估算。**

```
> claude auth status
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty", … ,"subscriptionType":"max"}

> codex login status
Logged in using ChatGPT
```

（`codex login status` 那一行是印在 **stderr** 的，exit 0；`claude auth status` 才是 stdout。
探測兩邊都讀。）

`total_cost_usd` 在這種帳號下是 CLI 依 token 用量算出來的 **API 等值金額**，
不另外收費，只算進方案的用量上限（用 API 金鑰登入才是真的帳單）。
app 因此在開機時探測一次登入方式（[`../src/main/cli-auth-probe.ts`](../src/main/cli-auth-probe.ts)，
解析器在 [`../src/shared/cli-auth.ts`](../src/shared/cli-auth.ts)），右側面板最下面一行會寫
`Claude · Max 訂閱` / `Codex · ChatGPT 訂閱`，估算的金額一律寫成 `≈$0.091`。
第 9 節說的「先把費用釘死」也因此換了做法：**不再有寫死的預算上限**，
用量上限變成執行對話框上的選填欄位，只有 API 金鑰登入才預先填 $2。

## 2026-09-15 更新：Muse 與 OpenCode 也能當無介面 agent

`AgentKind` 從兩支變成四支：`claude` | `codex` | `muse` | `opencode`。
「Agent 任務」的執行者、工作流 agent 節點的 `kind`、右側清單的標籤與「接手」
全部跟著變成四選一。

實測日期 2026-09-15，同一台 Windows 11 Enterprise LTSC 2024 (26100)：
Muse Code 1.3.0 (1.3.0-R3057.1)、`%LOCALAPPDATA%\Programs\muse\muse.cmd`；
`opencode` **1.18.31**、`%APPDATA%\npm\opencode.cmd`。兩支都是 `.cmd` shim，
所以跟 codex 一樣要走 `cmd.exe /c`。

### 命令

| 情境 | 命令 |
| --- | --- |
| Muse，不給改檔案 | `cmd.exe /c muse exec --json --prompt-file <tmp> --approval-mode untrusted --disable-write` |
| Muse，允許改檔案 | 同上，`--approval-mode never`（沒有 `--disable-write`） |
| Muse，接續 | 同上再加 `--session-id <session-uuid>` |
| OpenCode，不給改檔案 | `cmd.exe /c opencode run --format json --dir <cwd> [-m <provider/model>] --agent plan` |
| OpenCode，允許改檔案 | 同上，拿掉 `--agent plan` |
| OpenCode，接續 | 同上再加 `--session <ses_…>` |
| 人接手（互動式） | `muse resume <session-uuid>` ／ `opencode --session <ses_…>` |

提示的送法兩支不一樣：

- **Muse** 沒有 stdin 這條路，所以提示寫成一個暫存檔（`%TEMP%\myterminal-muse-<uuid>.txt`）
  再用 `--prompt-file` 讀，行程結束就刪。**絕對不要把提示放進 `cmd.exe` 的命令列** ——
  換行與引號一定會出事。（順帶一提：muse 是原封不動讀那個檔的，用 PowerShell 的
  `Set-Content -Encoding utf8` 寫會連 BOM 一起餵進去，變成 `嚜瞥ello…`。程式裡是
  Node 的 `writeFileSync(…, 'utf8')`，沒有 BOM。）
- **OpenCode** 的 `opencode run` **會從 stdin 讀訊息**（實測：不給任何 positional，
  把訊息 pipe 進去就照跑），所以跟 claude 一樣完全不必碰引號。

兩支都沒有 claude 的 `--append-system-prompt`，所以角色的前置指示跟 codex 一樣
接在提示前面（`<systemPrompt>\n\n<prompt>`）。

### 「不給改檔案」要用什麼

**Muse** 的 `--approval-mode` 有三個值，用 `--provider echo` 各跑過一次：

| 模式 | 無介面的行為 |
| --- | --- |
| `untrusted` | 要授權的工具被政策**直接擋掉**（stderr 印 `Agent delegation: auto unavailable: workspace is untrusted`），不是停下來問人。exit 0，不會卡住 |
| `on-request`（預設） | echo provider 不會叫工具，所以這次也是 exit 0；但它的語意就是「停下來問」，真的有工具要授權時無介面沒人可以回答 |
| `never` | 永遠不問 = 全部放行。exit 0 |

所以：`allowEdits=false` → `untrusted` 再加 `--disable-write`（關掉非 shell 的寫檔，
等價於 codex 的 `read-only`）；`allowEdits=true` → `never`。
**沒有驗證到的**：echo provider 根本不會發出工具呼叫，所以「untrusted 遇到真的
工具呼叫時是擋掉還是卡住」這件事只是照文件與那行 stderr 推的，沒有實測。

**OpenCode** 比較意外：`opencode run` **預設就直接寫檔，不問也不擋**。
叫它建一個檔案，`write` 工具 `status: "completed"`、`output: "Wrote file successfully."`，
檔案真的出現了 —— 而且沒有帶任何權限旗標。`--auto`（1.18 版取代了舊的
`--dangerously-skip-permissions`）只是「自動核准沒有被明確拒絕的權限」，
**不是**唯讀開關。真正的唯讀開關是內建的 **`plan` agent**：
`opencode agent list` 看得到它的權限是 `edit: *  deny`（只放行 plan 的 `.md`）。
實測 `--agent plan` 之下同一個提示回的是 `BLOCKED`，檔案沒有被建立，exit 0，不卡住。
所以 `allowEdits=false` → `--agent plan`，`allowEdits=true` → 不帶 `--agent`（預設是 `build`）。

### 接續（resume）

- **Muse**：`muse exec` **沒有** resume 子命令，只有 `--session-id <UUID>`（「use a
  specific session id」）。實測用同一個 uuid 跑第二次：stderr 印
  `warning: session <uuid> does not record a usable model for provider echo`
  （代表它真的把舊 session 讀出來了），而且事件的 `sequence` 從上一次的結尾
  **27 接到 28**，不是從 1 重來。所以接續就是「指定同一個 session id」。
  人接手用的是互動式的 `muse resume <session-uuid>`（`muse resume --help` 確認過，
  另有 `--last`）。
- **OpenCode**：`opencode run --session <ses_…>` 實測**記得上下文** ——
  第一輪告訴它一個暗號、第二輪問它，答得出來。
  人接手是頂層的 `opencode --session <id>`（`opencode --help` 確認過，TUI）。

### 事件形狀

**Muse `exec --json`**：一行一筆記錄，型別在 `payload_type`、內容在 `payload`、
session 掛在 `stream` 上（`stream.kind === 'session'` 時 `stream.id` 就是 session id）。
樣本：[`../test/fixtures/muse-echo-exec.jsonl`](../test/fixtures/muse-echo-exec.jsonl)
（`--provider echo` 抓的，27 行）。

| `payload_type` | 對應的 `AgentEvent` |
| --- | --- |
| `runtime.command.accepted` | `init`（一次執行只有一筆，所以拿它當 init） |
| `run.output.delta` | `text`（`payload.text`） |
| `task.lifecycle.proposed` | `tool`，名字是 `payload.event.task_kind`；`model.*` 濾掉（那只是模型自己的回合） |
| `task.lifecycle.failed` | `tool`，摘要是 `payload.event.reason` |
| `run.terminal.*` | `result`，成敗看 `payload.terminal === 'completed'`，文字取 `payload.text`，失敗時取 `payload.reason` |

**子任務失敗不等於整次執行失敗**：echo provider 的 `verify-reminder` 一定會丟
`invalid run configuration: provider does not support base instructions`，
但同一次執行的 `run.terminal.completed` 仍然是成功的。所以成敗一律看終端事件。

**OpenCode `run --format json`**：`{"type":…, "sessionID":…, "part":{…}}`。
樣本：[`../test/fixtures/opencode-run-json.jsonl`](../test/fixtures/opencode-run-json.jsonl)。

| `type` | 對應的 `AgentEvent` |
| --- | --- |
| （任何一行的 `sessionID`） | 第一次看到就發 `init` |
| `text` | `text`（`part.text`） |
| `tool_use` | `tool`，名字是 `part.tool`，摘要取 `part.state.input` 裡的 `filePath`／`command`／… |
| `step_finish` | `result`：`part.cost` 累加、`part.reason` 是 `stop`／`tool-calls`／`error` |
| `error`（頂層） | 失敗的 `result`，訊息取 `error.data.message` |

`tool_use` 的實際樣子（叫它列目錄）：

```json
{"type":"tool_use","sessionID":"ses_…","part":{"type":"tool","tool":"read",
 "callID":"call_…","state":{"status":"completed",
 "input":{"filePath":"C:\…\ws"},"output":"<path>…</path>\n<type>directory</type>…"}}}
```

注意 `filePath` 是**小駝峰**，跟 claude 的 `file_path` 不一樣，
所以 `SUMMARY_KEYS` 兩種都收。

OpenCode **沒有「這次跑完了」那種事件** —— 串流結束就是結束。所以結果是在每個
`step_finish` 上重新湊一份，最後留下來的那筆就是最終結果；費用要跨 step 累加、
回覆文字要把每段接起來，因此 `opencodeEvents()` 是一個**工廠**（有狀態，一次執行配一個），
不像 `claudeEvents` / `codexEvents` 是無狀態的模組常數。

`step_finish` 也帶 `part.tokens {total,input,output,reasoning,cache{write,read}}`，
但 `AgentEvent` 沒有放 token 數的欄位，所以目前只取 `cost`。
免費模型的 `cost` 是 `0`，這時不寫 `costUsd`（不然頁尾會出現一個 `$0.000`）。

失敗長這樣（指定一個這把金鑰拿不到的型號）：

```json
{"type":"error","sessionID":"ses_…","error":{"name":"APIError",
 "data":{"message":"key not allowed to access model. This key can only access models=[…]",
 "statusCode":403}}}
```

### 用免費模型驗到的（OpenCode）

`opencode/mimo-v2.5-free` **不需要任何金鑰**，只要有網路。上面 OpenCode 那幾段
（stdin、工具呼叫的 JSON、沒有旗標就寫檔、`--agent plan` 擋得住、`--session` 接得回去、
錯誤的形狀）全部是用它跑出來的，不是推的。

整條路徑也跑過一次 e2e：

```
MYTERMINAL_AGENT_E2E=1 MYTERMINAL_AGENT_E2E_OPENCODE=1 npx playwright test e2e/agent.spec.ts -g opencode
```

app → `cmd.exe /c opencode run --format json` → 事件解析 → 畫面上出現
`OPENCODE_E2E_OK` 與 `✔ 完成`，清單上有「接手」按鈕。約 1.6 分鐘，綠的。

**這台機器的 `opencode` 預設型號是內網 LiteLLM proxy 的 `litellm/claude-opus-4-8`，
那把金鑰拿不到它（403）**，所以不指定 `-m` 會直接失敗。正式路徑的型號來自
「CLI 設定」（`provider` + `model` → `-m <provider>/<model>`），但那張供應商清單只有
Anthropic／OpenAI／Google／OpenRouter 四家，寫不出 `opencode/mimo-v2.5-free`。
因此 `OpenCodeRunner` 多讀一個環境變數 **`MYTERMINAL_OPENCODE_MODEL`**（優先於
「CLI 設定」），e2e 就是靠它把免費模型帶進去的。`OPENCODE_MODEL` 沒有用（試過，
opencode 不讀）。

> 後來供應商清單補了第五個選項 **「OpenCode 免費模型（不需金鑰）」**（`provider: 'opencode'`，
> 型號留空就是 `mimo-v2.5-free`），所以一般使用者在「CLI 設定」裡就選得到免費模型，
> 不必再靠環境變數；環境變數保留給 e2e（它仍然優先）。

### Muse 沒有驗到的

這台機器**既沒有 `muse login` 也沒有 `META_API_KEY`**，所以 meta provider 一次都沒跑過。
以下全部是未知，解析器對這些一律防禦性處理（認不得的行就忽略）：

- **真正的工具呼叫長什麼樣子**。echo provider 不會叫工具，所以 `task_kind` 除了
  `reminder.agent.*` 與 `model.unknown.response` 之外會出現什麼、`tool` 事件的摘要
  該從哪個欄位取，都沒看過。目前只拿 `task.lifecycle.proposed` 的 `task_kind` 當名字。
- **有沒有用量／費用欄位**。echo 的事件裡完全沒有 token 或金額，所以 Muse 的 `result`
  目前不帶 `costUsd`，頁尾也就不會有金額那一段。
- **失敗時 `run.terminal.*` 的實際型別與 `reason`**。只看過 `run.terminal.completed`
  （`terminal: "completed"`, `reason: null`）。失敗路徑的單元測試用的是手寫的
  `run.terminal.failed`，不是抓下來的。
- `e2e/agent.spec.ts` 的 muse 那個測試因此**從來沒有真的跑過**，
  要 `MYTERMINAL_AGENT_E2E_MUSE=1` 才會跑，skip 訊息裡有寫。

### 金鑰注入

以前只有互動式工作階段吃得到「CLI 設定」的金鑰（`ShellFactory` 拿 `CliSecrets`）。
現在 runner 工廠也拿同一條縫線（`agentRunners(secrets)`），所以 `META_API_KEY`／
`ANTHROPIC_API_KEY`／… 在 **Agent 任務與工作流節點**也會被注入。
`ProcessSpec` 因此多了一個 `env`，`NodeProcessSpawner` 把它疊在 `process.env` 上。
無介面一律在 Windows 原生跑，所以 `baseShell` 固定傳 `powershell`（不會有 WSLENV 那段）。


## 2026-09-17 更新：權限從兩檔變成三檔

第 8 節的風險 1（「`allowEdits` 只有兩檔」）踩到了：
**`claude -p --permission-mode acceptEdits` 改得了檔案，卻擋掉 Bash 指令。**
這台機器上實測，`git --version` 與 `npm --version` 都進了結果的
`permission_denials`（只有 `echo` 這種擺明無害的過得去），所以工程師 /
測試工程師節點的「實作完要跑測試」根本做不到。

`--permission-mode bypassPermissions` 同一句話實測會真的執行，
`permission_denials` 是空的（`~/.claude/settings.json` 有
`skipDangerousModePermissionPrompt: true`，所以不會停下來問）。

因此 `AgentTask.allowEdits: boolean` 換成
`AgentTask.permission: 'readonly' | 'edit' | 'full'`，各家的對應寫在
[`WORKFLOW.md`](WORKFLOW.md#為什麼需要-full)。`full` 用的是
claude `bypassPermissions`、codex `danger-full-access`、muse `never`、
opencode `--auto`；互動式那一面（畫布上的「開終端機並啟動 <CLI>」）
補的是 `--dangerously-skip-permissions`。

順便驗到的坑：把 `Bash(git --version)` 寫進目標專案的
`.claude/settings.json` 的 `permissions.allow`，在**沒有被信任過**的目錄裡
整份會被忽略（claude 印 `Ignoring 1 permissions.allow entry ... this
workspace has not been trusted`），照樣被擋。這條路要先用互動式 claude
在那個目錄開過一次、按過信任才算數。
