# 工作流

把「跑一次 agent」串成「跑一串 agent，中間可以分支、可以問人」。

**每一個工作流都跑在 LangGraph 上**（`@langchain/langgraph`）。這裡沒有自己寫的
排程器：`GraphCompiler` 把一份 JSON 定義編譯成真的 `StateGraph`，節點之間怎麼走、
狀態怎麼合併、中斷之後怎麼接回去，全部是 LangGraph 的工作。

內建範本一個，加上一張 **LabVIEW 風格的拖拉畫布**（見下面的[畫布編輯器](#畫布編輯器)）——
畫布編輯的就是下面這份 JSON，所以 schema 一開始就帶著節點座標。

## JSON schema（version 1）

型別定義在 [`src/shared/workflow.ts`](../src/shared/workflow.ts)。

```ts
type WorkflowDefinition = {
  version: 1;
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

type WorkflowNode = {
  id: string;
  type: 'start' | 'end' | 'agent' | 'condition' | 'approval';
  label: string;              // 畫面上與畫布上顯示的名字
  position: { x: number; y: number };   // 畫布上的位置
  config: ...;                // 依 type 而定，start / end 沒有 config
};

type WorkflowEdge = {
  from: string;
  to: string;
  port?: 'ok' | 'fail' | 'yes' | 'no' | 'approved' | 'rejected';
};
```

各型別的 `config`：

| type | config | 出口 (port) |
| --- | --- | --- |
| `start` | — | 一條沒有名字的連線 |
| `end` | — | 沒有出口 |
| `agent` | `{ kind, prompt, cwd?, allowEdits, role?, resumeFrom?, maxAttempts?, timeoutSec? }` | `ok` / `fail` |
| `condition` | `{ source, rule }` | `yes` / `no` |
| `approval` | `{ question }` | `approved` / `rejected` |

`agent.config`：

| 欄位 | 說明 |
| --- | --- |
| `kind` | `'claude'` 或 `'codex'`，走的是 Agent 任務那條既有的 `IAgentRunner` |
| `prompt` | 樣板，見下面的「樣板」 |
| `cwd` | 也吃樣板；不能留空（驗證會擋），而且執行前會檢查代入後的目錄真的存在 |
| `allowEdits` | `false` 是 Claude 的 `plan`／Codex 的 `read-only`，`true` 才會動檔案 |
| `role` | 角色 id，見下面的「角色」。省略就沒有前置指示 |
| `resumeFrom` | 某個節點的 id：用那個節點的 CLI session 接續對話（`claude --resume`） |
| `maxAttempts` | 這個節點最多跑幾次（迴圈用），預設 3。超過就把整個執行標成失敗並收尾 |
| `timeoutSec` | 單一次執行的上限，預設 600。超過就取消 CLI，這個節點算失敗 |

`condition.rule` 目前兩種：`{ type: 'lastLineEquals', value }`（只看 `source` 節點輸出的
最後一行）與 `{ type: 'regex', pattern }`（整段比對）。

### 角色

角色是**一段可以重複用的系統提示前言**，加上一個預設的檔案修改權限。
定義在 [`src/shared/roles.ts`](../src/shared/roles.ts)，就五個，改一次全部生效：

| `role` | 名稱 | 做什麼 | `allowEdits` 預設 |
| --- | --- | --- | --- |
| `pm` | 產品經理 | 把需求拆成可驗收的工作項目，不寫程式 | 關 |
| `architect` | 架構師 | 設計模組邊界與介面、說明取捨，不實作細節 | 關 |
| `coder` | 工程師 | 依指示實作、跑測試，最後摘要改了哪些檔案 | **開** |
| `tester` | 測試工程師 | 撰寫並執行測試，回報失敗的測試與原因 | **開** |
| `reviewer` | 審查者 | 只審查不修改，最後一行輸出 `PASS` 或 `FAIL` | 關 |

怎麼送給 CLI（[`agent-runner.ts`](../src/main/agent-runner.ts)）：

- **claude**：多一組 `--append-system-prompt <前置指示>`，排在 `--resume` 前面。
- **codex**：沒有對應的旗標，所以前置指示接在提示前面（`<前置指示>

<提示>`）
  一起走 stdin。

`allowEdits` 的預設值只是**對話框上的方便**：在「Agent 任務」裡換角色時，
「允許修改檔案」會跟著跳到那個角色的預設值，之後還是可以自己改。
節點的 `allowEdits` 是定義裡寫死的，角色不會覆寫它。

角色不存在時 `validateWorkflow` 會報 `節點 <id> 的角色不存在：<role>`。
`RunNodeState` 也複製一份 `role`，右側清單才貼得出那個標籤。

### 樣板

`prompt` 與 `cwd` 會先代入再送出去，只有兩種變數：

| 寫法 | 代入 |
| --- | --- |
| `{{<節點id>.text}}` | 那個節點的輸出文字 |
| `{{params.<名稱>}}` | 啟動時填的參數（範本是 `task` 與 `cwd`） |

找不到的來源代空字串；看不懂的樣板原樣留著。**沒有其他變數、沒有運算式**。

### 例子

內建範本「實作 → 審查 → 批准」（完整版在
[`src/main/workflow/templates.ts`](../src/main/workflow/templates.ts)）：

```jsonc
{
  "version": 1,
  "id": "implement-review-approve",
  "name": "實作 → 審查 → 批准",
  "nodes": [
    { "id": "start", "type": "start", "label": "開始", "position": { "x": 0, "y": 0 } },
    { "id": "implement", "type": "agent", "label": "實作", "position": { "x": 180, "y": 0 },
      "config": { "kind": "claude", "prompt": "{{params.task}}", "cwd": "{{params.cwd}}",
                  "allowEdits": true } },
    { "id": "review", "type": "agent", "label": "審查", "position": { "x": 360, "y": 0 },
      "config": { "kind": "claude", "allowEdits": false, "cwd": "{{params.cwd}}",
                  "prompt": "審查目前工作目錄的變更是否完成「{{params.task}}」，最後一行只輸出 PASS 或 FAIL" } },
    { "id": "check", "type": "condition", "label": "檢查", "position": { "x": 540, "y": 0 },
      "config": { "source": "review", "rule": { "type": "lastLineEquals", "value": "PASS" } } },
    { "id": "approve", "type": "approval", "label": "批准", "position": { "x": 720, "y": 0 },
      "config": { "question": "要保留這次的變更嗎？" } },
    { "id": "fix", "type": "agent", "label": "修正", "position": { "x": 540, "y": 160 },
      "config": { "kind": "claude", "allowEdits": true, "cwd": "{{params.cwd}}",
                  "prompt": "審查意見如下，請修正：{{review.text}}",
                  "resumeFrom": "implement", "maxAttempts": 3 } },
    { "id": "end", "type": "end", "label": "結束", "position": { "x": 900, "y": 0 } }
  ],
  "edges": [
    { "from": "start", "to": "implement" },
    { "from": "implement", "to": "review", "port": "ok" },
    { "from": "review", "to": "check", "port": "ok" },
    { "from": "check", "to": "approve", "port": "yes" },
    { "from": "check", "to": "fix", "port": "no" },
    { "from": "fix", "to": "review", "port": "ok" },
    { "from": "approve", "to": "end", "port": "approved" }
  ]
}
```

**沒有連線的出口就是「到此為止」**：上面 `implement` / `review` / `fix` 的 `fail`
與 `approve` 的 `rejected` 都沒有連線，走到那裡整個執行就結束。因為沒有走到
`end` 節點，狀態是「失敗」，原因寫在 `RunState.error` 裡 —— 只有 `rejected`
（人按了「退回」）例外，那是「已退回」，不是壞掉，所以沒有 `error`。

### 驗證

`validateWorkflow(def)` 回傳錯誤訊息陣列（空陣列代表合法），十條規則：

1. 剛好一個 `start` 節點
2. 至少一個 `end` 節點
3. 每條連線的兩端節點都存在
4. 有出口的節點必須指定自己的出口；`start` / `end` 不能指定
5. 同一個出口只能有一條連線
6. 沒有從 `start` 走不到的節點
7. `agent` 的 `prompt` 不能是空白 —— `節點 <id> 的提示不能是空的`
8. `agent` 的 `cwd` 不能是空白 —— `節點 <id> 的工作目錄不能是空的`
9. `condition` 的 `source` 必須是**存在的 `agent` 節點**（沒有輸出的節點看不出結果，
   那個條件會永遠走「否」）—— `節點 <id> 的條件來源不存在：<source>`
10. `condition` 的正規式編得起來 —— `節點 <id> 的正規式無效`

角色不存在時另外報 `節點 <id> 的角色不存在：<role>`。

`GraphCompiler.compile()` 第一件事就是跑它，不合法直接丟例外，不會編譯出半殘的圖。

**執行前再檢查一次工作目錄**：`WorkflowService.start()` 看 `params.cwd` 存不存在，
不存在就直接以 `工作目錄不存在：<path>` 拒絕，連一筆執行都不會建立 ——
不然 CLI 只會回一句 `spawn claude ENOENT`，看不出是目錄的問題。
執行對話框收到拒絕時會留在原地把訊息顯示出來。

### 自訂工作流的儲存

內建範本寫死在 `templates.ts`，使用者自己的工作流存成一份 JSON：

```
%APPDATA%\myterminal\workflows.json
```

就是一個 `WorkflowDefinition` 陣列，**跟範本同一種格式**，手動編輯也可以
（形狀不對的項目讀的時候直接忽略，壞掉的 JSON 當成空清單）。管它的是
[`workflow-store.ts`](../src/main/workflow/workflow-store.ts) 的 `WorkflowStore`，
跟 `ProfileStore` 同一個寫法：讀寫都是注入的兩個函式，測試不碰檔案系統。

- **存的時候會先驗證**：`validateWorkflow()` 有錯就丟例外（訊息是每行一條），整份不寫。
- **不能蓋掉內建範本**：id 撞到 `TEMPLATES` 裡的就丟「不能覆蓋內建範本」。
- 以 `id` upsert，覆寫時保留原本的順序。

[`catalog.ts`](../src/main/workflow/catalog.ts) 把兩邊併起來，IPC 只問它 ——
`listWorkflows()` 是內建的排前面、自訂的（`builtin: false`）接在後面，
`findWorkflow(id)` 先找範本再找自訂的。所以 `workflow:start` 不必知道
一個 id 是哪一種。

| 頻道 | 參數 | 回傳 |
| --- | --- | --- |
| `workflow:list` | — | `WorkflowInfo[]`（`{ id, name, builtin }`） |
| `workflow:get` | `id` | `WorkflowDefinition` 或 `undefined` |
| `workflow:save` | `WorkflowDefinition` | — ，不合法就以驗證訊息 reject |
| `workflow:delete` | `id` | — ，不存在就什麼都不做 |

## 畫布編輯器

自己的工作流不必手寫 JSON。右側「工作流」那一列的**「編輯」**打開畫布，
它編輯的就是上面那份 `WorkflowDefinition` —— 存出來跟內建範本是同一種東西。

```
[開始]───────→[ Agent 實作 ]──成功──→[ 條件 檢查 ]──是──→[ 結束 ]
                  工程師 claude ●失敗                  ●否
```

### 畫面

| 區塊 | 內容 |
| --- | --- |
| 上方那一條 | 「← 回終端機」、工作流下拉（＋新工作流／內建／自訂）、名稱、調色盤、刪除、儲存、儲存並執行 |
| 中間 | 畫布：節點卡片與連線。按著空白處拖曳可以平移 |
| 右側 | 屬性面板：選到的節點（或連線）的設定 |
| 上方那一條下面 | 驗證與儲存的錯誤，一行一條；沒有錯誤時不出現 |

### 操作

- **加節點**：調色盤的「＋ Agent／條件／批准／結束」。新節點放在**最右邊那個節點的右側**，
  拖到你要的位置（座標會吸附到 10px 的格線上）。id 自動取 `agent-1`、`condition-2` 這種，
  刪掉之後號碼會補回來。**開始節點刪不掉**。
- **接線**：從節點**右側的出口**圓點拉到另一個節點**左側的入口**圓點（放在卡片上也算）。
  規則跟 `validateWorkflow` 一致：不能接回自己、不能接到開始節點、出口必須是自己這個
  型別有的那幾個。**同一個出口再拉一次是「改接」不是多一條**（出口只能有一條線），
  這一點跟 LabVIEW 一樣。接不起來時原因會在上面顯示三秒。
- **刪東西**：點一下節點或連線選起來（連線的感應範圍比看到的粗），按 `Delete` 或
  `Backspace`。刪節點會一起刪掉它的連線，以及別的節點對它的 `resumeFrom` / `source` 參照。
- **改內容**：選起來之後在右側面板改。

### 屬性面板

| 節點 | 可以設的東西 |
| --- | --- |
| 全部 | 節點 id（唯讀，提示裡用 `{{<id>.text}}` 取得它的輸出）、名稱 |
| `agent` | 執行者（claude／codex）、角色、提示、工作目錄、允許修改檔案、接續對話（`resumeFrom`）、最多幾次、逾時 |
| `condition` | 看哪個 agent 節點的輸出、判斷方式（最後一行等於／符合正規式）與值 |
| `approval` | 要問的問題 |

換**角色**時「允許修改檔案」會跟著跳到那個角色的預設值（跟「新連接」對話框一樣），
之後還是可以自己改。角色的清單見上面的[角色](#角色)。

### 儲存

按「儲存」會先在本地跑一次 `validateWorkflow()`，有錯就列在上面且不送出去；
沒錯才走 `workflow:save`（main 存檔前還會再驗證一次）。

- **內建範本存的是副本**：載入的是內建範本時，儲存會自動換一個新 id 並在名字後面加
  「 (副本)」，接下來編輯的就是那份副本 —— 範本永遠不會被蓋掉（main 那邊本來就不讓覆蓋）。
- 存進 `%APPDATA%\myterminal\workflows.json`，跟手寫的自訂工作流同一個檔案、同一種格式，
  細節見上面的[自訂工作流的儲存](#自訂工作流的儲存)。
- 存完「刪除」才會亮（只有自訂工作流刪得掉），而且執行對話框的「自訂」分組馬上看得到它。
- **「儲存並執行」**＝存起來 + 打開執行對話框並預選這一個。

### 程式碼

沒有用任何畫布／流程圖套件：節點是絕對定位的 `<div>`，連線是一層 `<svg>` 裡的
`<path>`（立方貝茲，另有一條加粗的透明線負責吃滑鼠）。

| 檔案 | 責任 |
| --- | --- |
| [`workflow-editor-model.ts`](../src/renderer/workflow-editor-model.ts) | 狀態與規則：id、座標吸附、接線合不合法、刪節點要清掉什麼、接點座標。跟 `AppState` 同一套 Observer，**完全不碰 DOM** |
| [`workflow-editor-view.ts`](../src/renderer/workflow-editor-view.ts) | DOM 殼：卡片、連線、屬性面板、滑鼠與鍵盤 |
| [`commands.ts`](../src/renderer/commands.ts) | 開啟／關閉／儲存／刪除／儲存並執行，各一個 `ICommand` |

規則都在 model 裡，所以 vitest 的 node 環境測得到
（`test/workflow-editor-model.spec.ts`）；畫面與滑鼠則由
`e2e/editor.spec.ts` 顧（不呼叫任何 CLI，所以不花錢）。

## 執行時的狀態

LangGraph 的 `Annotation` 有四個 channel（[`graph-compiler.ts`](../src/main/workflow/graph-compiler.ts)）：

| channel | reducer | 內容 |
| --- | --- | --- |
| `outputs` | 合併 | `節點id -> { text, sessionId?, ok, costUsd?, durationMs? }`，`sessionId` 是 **CLI 的** session（`resumeFrom` 用的） |
| `attempts` | 合併 | `節點id -> 跑過幾次`，`maxAttempts` 看它 |
| `lastPort` | 合併 | `節點id -> 走了哪個出口`，`addConditionalEdges` 的 router 只看它 |
| `totalCostUsd` | 相加 | 這次執行累計的用量（訂閱帳號是估算，見下面的「用量與上限」） |

一次執行的狀態（`RunStatus`）與每個節點的狀態（`RunNodeStatus`）：

| `RunStatus` | 畫面上 | 什麼時候 |
| --- | --- | --- |
| `running` | 執行中 | 剛開始或批准之後接下去 |
| `waiting_approval` | 等待批准 | 停在 `approval` 節點 |
| `done` | 完成 | 走到 `end` 節點 |
| `failed` | 失敗 | 節點失敗、重試用完、超出用量上限、沒走到 `end`；`error` 寫原因 |
| `cancelled` | 已取消 | 人按了「取消」 |
| `rejected` | 已退回 | 人按了「退回」。不是壞掉，所以徽章是中性色、也沒有 `error` |

| `RunNodeStatus` | 狀態點 |
| --- | --- |
| `idle` / `running` / `done` / `failed` | 還沒輪到／執行中／完成／失敗 |
| `waiting` | 等待批准（空心） |
| `skipped` | 沒輪到就收尾了（只有外框） |
| `cancelled` | 執行被取消時正在跑的那個（中性色，不是紅的失敗） |

`WorkflowService` 另外維護給畫面看的 `RunState`（執行狀態、每個節點的狀態與
**畫面上的** `sessionId`、累計費用）。兩者分開是刻意的：圖的狀態是編排用的，
`RunState` 是 UI 用的，後者由編排層在節點開始／結束時回報（`NodeReport`）—— 因為
圖的狀態要等超步結束才看得到，但畫面要馬上知道「哪個節點正在跑」。

## 用量與上限

CLI 回報的 `total_cost_usd` **不一定是錢**：用訂閱登入（claude.ai / ChatGPT）時
它只是依 token 用量估算的 API 等值金額，不另外收費，只算進方案的用量上限；
用 API 金鑰登入才是真的帳單。app 開機時問一次兩支 CLI
（`claude auth status`、`codex login status`，見
[`src/main/cli-auth-probe.ts`](../src/main/cli-auth-probe.ts)），結果顯示在右側面板
最下面那一行（`#cli-status`），並決定金額怎麼寫：估算是 `≈$0.175`，真的費用是 `$0.175`。

用量上限因此是**這一次執行的**選項，不是寫死的預算：

| 在哪裡 | 行為 |
| --- | --- |
| 執行對話框「用量上限（估算美元）」 | 留空＝不限制。只有 `claude` 是用 API 金鑰登入時才預先填 `DEFAULT_MAX_TOTAL_COST_USD`（$2） |
| `workflow:start` 的 `maxTotalCostUsd` | 一路傳到 `WorkflowService.start(def, params, { maxTotalCostUsd })`，再變成 `CompileDeps.budget` |
| `GraphCompiler` | `budget.maxTotalCostUsd` 是 `undefined` 就永遠不會超出；有值而且累計加上這次會超過時，那個節點算失敗、輸出寫「超出這次執行的用量上限 (估算 $2)」並收尾 |

## 一個節點怎麼變成工作階段

`agent` 節點不是「偷偷跑一個行程」，而是**畫面上一個普通的工作階段**：

```
編排層 compile() 的節點函式
  → runnerFactory(kind).start(task)      // 既有的 IAgentRunner
  → sessions.adoptAgentRun(run, spec)    // SessionManager 收編成一個工作階段
  → 右側清單出現「<工作流名稱> · <節點 label>」
```

所以它有終端機、看得到輸出、能開紀錄、**也能「接手」**（CLI 回報 session id 之後
那一列會出現「接手」按鈕，按下去開一個真的互動式 `claude --resume <id>`）。
工作流清單裡點節點那一列，就是切到那個工作階段的終端機。

## 中斷與接續

`approval` 節點呼叫 LangGraph 的 `interrupt({ question })`，整張圖停在那裡，
狀態存進 checkpointer。人按「批准」或「退回」時，`WorkflowService.resume()` 用
`new Command({ resume: { approved } })` 再 `invoke` 一次，圖從中斷的地方接下去。

Checkpointer 是 `JsonFileSaver`：一個執行一個檔案，
`%APPDATA%\myterminal\workflow-runs\<runId>.json`。因為它是檔案，
**app 關掉再開，等待批准的執行還在，按批准就繼續跑**。
執行清單的摘要另外存在 `workflow-runs.json`（定義與參數也一起存，重開之後才重編得出圖）。

> `Command` 的 `resume` 值一定要是**真值**：LangGraph 的 `mapCommand` 用
> `if (cmd.resume)` 判斷，直接傳 `false` 會被當成空輸入丟 `EmptyInputError`。
> 所以批准／退回傳的是 `{ approved: boolean }` 而不是 `boolean`。

## 怎麼加一種新的節點型別

跟「怎麼加一種新的工作階段類型」一樣，型別知識集中在少數幾個地方：

1. [`src/shared/workflow.ts`](../src/shared/workflow.ts)：
   `WorkflowNodeType` 加一個成員、`WorkflowNode` 判別聯集加一個變體（帶它的 `config`）、
   `NODE_PORTS` 補上它的出口清單。TypeScript 會強迫你補齊後面每一處。
2. [`src/main/workflow/graph-compiler.ts`](../src/main/workflow/graph-compiler.ts)：
   `action()` 的 `switch` 加一個 `case`，回傳一個
   `(state) => Partial<RunGraphState>`。要有出口就寫 `lastPort[node.id]`；
   連線那一段不用動（有出口的節點一律走 `addConditionalEdges`）。
3. 節點需要新的執行時能力（例如新的外部系統）就加進 `CompileDeps`，
   由 `WorkflowService` 注入，測試傳假的。

驗證、router、持久化、畫面都不必改 —— 畫面是照 `RunState.nodes` 畫的，
新節點自動會有一列。

## 還沒做的

平行節點（LangGraph 的 `Send`）、`{{節點.text}}` 與 `{{params.x}}` 以外的變數、
子圖、排程。畫布這一側：復原／重做、框選、縮放。

加畫布時**執行那一側一行都沒改** —— 畫布存出來的還是同一份 `WorkflowDefinition`，
`GraphCompiler` 照樣編譯。

## Windows 上的坑

- **工作目錄不要用 8.3 短路徑**。這台機器的 `%TEMP%` 是
  `C:\Users\ROBERT~1\AppData\Local\Temp`，`claude` 會把 `ROBERT~1` 這種短檔名
  判定成可疑路徑要求手動核准，而 `-p` 非互動模式核准不了 —— `acceptEdits` 也
  救不回來。實測 agent 會回「兩次寫入都被權限系統擋下」然後什麼都不做，
  審查因此一直 FAIL，最後卡在 `maxAttempts`。`e2e/workflow.spec.ts` 用
  `realpathSync.native()` 把暫存目錄展開成長路徑就正常了。
- 其他 CLI 相關的坑（`.cmd` shim、stdin、`--verbose`）見
  [`AGENT-SPIKE.md`](AGENT-SPIKE.md) 第 6 節，工作流走的是同一條 `IAgentRunner`。
