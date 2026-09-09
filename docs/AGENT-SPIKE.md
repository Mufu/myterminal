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
