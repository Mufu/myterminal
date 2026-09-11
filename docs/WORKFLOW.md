# 工作流（Phase 1）

把「跑一次 agent」串成「跑一串 agent，中間可以分支、可以問人」。

**每一個工作流都跑在 LangGraph 上**（`@langchain/langgraph`）。這裡沒有自己寫的
排程器：`GraphCompiler` 把一份 JSON 定義編譯成真的 `StateGraph`，節點之間怎麼走、
狀態怎麼合併、中斷之後怎麼接回去，全部是 LangGraph 的工作。

Phase 1 只有一個內建範本與一份清單畫面。**Phase 2 會是 LabVIEW 風格的拖拉畫布**，
畫布編輯的就是下面這份 JSON —— 所以 schema 現在就帶著節點座標。

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
  position: { x: number; y: number };   // Phase 2 的畫布用
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
| `agent` | `{ kind, prompt, cwd?, allowEdits, resumeFrom?, maxAttempts?, timeoutSec? }` | `ok` / `fail` |
| `condition` | `{ source, rule }` | `yes` / `no` |
| `approval` | `{ question }` | `approved` / `rejected` |

`agent.config`：

| 欄位 | 說明 |
| --- | --- |
| `kind` | `'claude'` 或 `'codex'`，走的是 Agent 任務那條既有的 `IAgentRunner` |
| `prompt` | 樣板，見下面的「樣板」 |
| `cwd` | 也吃樣板；留空時用家目錄 |
| `allowEdits` | `false` 是 Claude 的 `plan`／Codex 的 `read-only`，`true` 才會動檔案 |
| `resumeFrom` | 某個節點的 id：用那個節點的 CLI session 接續對話（`claude --resume`） |
| `maxAttempts` | 這個節點最多跑幾次（迴圈用），預設 3。超過就把整個執行標成失敗並收尾 |
| `timeoutSec` | 單一次執行的上限，預設 600。超過就取消 CLI，這個節點算失敗 |

`condition.rule` 目前兩種：`{ type: 'lastLineEquals', value }`（只看 `source` 節點輸出的
最後一行）與 `{ type: 'regex', pattern }`（整段比對）。

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
與 `approve` 的 `rejected` 都沒有連線，走到那裡整個執行就結束，而且因為沒有走到
`end` 節點，狀態是「失敗」，原因寫在 `RunState.error` 裡。

### 驗證

`validateWorkflow(def)` 回傳錯誤訊息陣列（空陣列代表合法），六條規則：

1. 剛好一個 `start` 節點
2. 至少一個 `end` 節點
3. 每條連線的兩端節點都存在
4. 有出口的節點必須指定自己的出口；`start` / `end` 不能指定
5. 同一個出口只能有一條連線
6. 沒有從 `start` 走不到的節點

`GraphCompiler.compile()` 第一件事就是跑它，不合法直接丟例外，不會編譯出半殘的圖。

## 執行時的狀態

LangGraph 的 `Annotation` 有四個 channel（[`graph-compiler.ts`](../src/main/workflow/graph-compiler.ts)）：

| channel | reducer | 內容 |
| --- | --- | --- |
| `outputs` | 合併 | `節點id -> { text, sessionId?, ok, costUsd?, durationMs? }`，`sessionId` 是 **CLI 的** session（`resumeFrom` 用的） |
| `attempts` | 合併 | `節點id -> 跑過幾次`，`maxAttempts` 看它 |
| `lastPort` | 合併 | `節點id -> 走了哪個出口`，`addConditionalEdges` 的 router 只看它 |
| `totalCostUsd` | 相加 | 這次執行累計花了多少錢 |

`WorkflowService` 另外維護給畫面看的 `RunState`（執行狀態、每個節點的狀態與
**畫面上的** `sessionId`、累計費用）。兩者分開是刻意的：圖的狀態是編排用的，
`RunState` 是 UI 用的，後者由編排層在節點開始／結束時回報（`NodeReport`）—— 因為
圖的狀態要等超步結束才看得到，但畫面要馬上知道「哪個節點正在跑」。

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

## Phase 2（畫布）會加什麼

schema 不用改就能撐住的部分：

- **節點座標**已經在 `position` 裡，畫布直接讀寫。
- **連線與出口**已經是 `edges[].port`，畫布上就是節點右邊的兩個接點。
- **驗證**是純函式，畫布可以邊拉邊跑 `validateWorkflow()` 即時回報。

畫布要另外加的東西（Phase 1 刻意沒做）：定義的儲存庫（現在只有寫死的範本，
`TEMPLATES` 要變成一個像 `ProfileStore` 的 Repository）、節點屬性面板、
以及連線的路徑計算。**執行這一側完全不用動**：畫布存出來的還是同一份
`WorkflowDefinition`，`GraphCompiler` 照樣編譯。

Phase 1 也刻意沒有的：平行節點（LangGraph 的 `Send`）、`{{節點.text}}` 與
`{{params.x}}` 以外的變數、子圖、排程。

## Windows 上的坑

- **工作目錄不要用 8.3 短路徑**。這台機器的 `%TEMP%` 是
  `C:\Users\ROBERT~1\AppData\Local\Temp`，`claude` 會把 `ROBERT~1` 這種短檔名
  判定成可疑路徑要求手動核准，而 `-p` 非互動模式核准不了 —— `acceptEdits` 也
  救不回來。實測 agent 會回「兩次寫入都被權限系統擋下」然後什麼都不做，
  審查因此一直 FAIL，最後卡在 `maxAttempts`。`e2e/workflow.spec.ts` 用
  `realpathSync.native()` 把暫存目錄展開成長路徑就正常了。
- 其他 CLI 相關的坑（`.cmd` shim、stdin、`--verbose`）見
  [`AGENT-SPIKE.md`](AGENT-SPIKE.md) 第 6 節，工作流走的是同一條 `IAgentRunner`。
