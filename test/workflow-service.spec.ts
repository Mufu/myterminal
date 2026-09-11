import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowService } from '../src/main/workflow/workflow-service';
import type { WorkflowServiceDeps } from '../src/main/workflow/workflow-service';
import { fileCheckpointSaver } from '../src/main/workflow/json-file-saver';
import { findTemplate } from '../src/main/workflow/templates';
import type { RunState, WorkflowDefinition, WorkflowNode } from '../src/shared/workflow';
import {
  FakeSessions,
  ManualTimers,
  ScriptedRunner,
  agentResult,
  until,
} from './fakes/fake-workflow';

const at = { x: 0, y: 0 };

const linear = (): WorkflowDefinition => ({
  version: 1,
  id: 'w',
  name: '測試流程',
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: at },
    {
      id: 'impl',
      type: 'agent',
      label: '實作',
      position: at,
      config: { kind: 'claude', prompt: '{{params.task}}', cwd: 'D:/work', allowEdits: true },
    },
    { id: 'ask', type: 'approval', label: '批准', position: at, config: { question: '要保留嗎？' } },
    { id: 'skipme', type: 'agent', label: '備援', position: at, config: agentConfig() },
    { id: 'end', type: 'end', label: '結束', position: at },
  ],
  edges: [
    { from: 'start', to: 'impl' },
    { from: 'impl', to: 'ask', port: 'ok' },
    { from: 'impl', to: 'skipme', port: 'fail' },
    { from: 'skipme', to: 'end', port: 'ok' },
    { from: 'ask', to: 'end', port: 'approved' },
  ],
});

function agentConfig(): Extract<WorkflowNode, { type: 'agent' }>['config'] {
  return { kind: 'claude', prompt: 'x', cwd: 'D:/work', allowEdits: false };
}

/** 測試共用的一份「磁碟」：清單存在記憶體字串，checkpoint 存在暫存目錄。*/
class Disk {
  runs: string | null = null;
  constructor(readonly dir: string) {}

  deps(over: Partial<WorkflowServiceDeps> = {}): WorkflowServiceDeps {
    return {
      runnerFactory: () => new ScriptedRunner(() => agentResult()),
      sessions: new FakeSessions(),
      checkpointer: fileCheckpointSaver(this.dir),
      read: () => this.runs,
      write: (content) => {
        this.runs = content;
      },
      timers: new ManualTimers(),
      now: () => 1_000,
      newRunId: () => 'run-1',
      ...over,
    };
  }
}

let disk: Disk;

beforeEach(() => {
  disk = new Disk(mkdtempSync(join(tmpdir(), 'myterminal-wf-')));
});

afterEach(() => {
  rmSync(disk.dir, { recursive: true, force: true });
});

const waitFor = async (service: WorkflowService, status: RunState['status']): Promise<RunState> => {
  await until(() => service.list()[0]?.status === status);
  return service.list()[0];
};

describe('WorkflowService', () => {
  it('start 之後會有一筆執行，節點狀態隨著進度更新', async () => {
    const sessions = new FakeSessions();
    const service = new WorkflowService(disk.deps({ sessions }));
    const runId = service.start(linear(), { task: '建立 hello.txt' });

    expect(runId).toBe('run-1');
    expect(service.list()[0]).toMatchObject({
      runId: 'run-1',
      workflowId: 'w',
      name: '測試流程',
      status: 'running',
      totalCostUsd: 0,
      startedAt: 1_000,
    });

    const waiting = await waitFor(service, 'waiting_approval');
    expect(waiting.question).toBe('要保留嗎？');
    expect(waiting.nodes.impl).toMatchObject({ status: 'done', sessionId: 's1', attempts: 1 });
    expect(waiting.nodes.ask.status).toBe('waiting');
    expect(waiting.totalCostUsd).toBeCloseTo(0.1);
    // 提示樣板是在編排層代入的，所以工作階段的名字與提示都是最終版本。
    expect(sessions.adopted).toEqual([
      { name: '測試流程 · 實作', kind: 'claude', prompt: '建立 hello.txt', cwd: 'D:/work' },
    ]);
  });

  it('changed 事件跟 list() 是同一份內容', async () => {
    const service = new WorkflowService(disk.deps());
    const seen: RunState[][] = [];
    service.on('changed', (runs) => seen.push(runs));
    service.start(linear(), {});

    await waitFor(service, 'waiting_approval');
    expect(seen.at(-1)).toEqual(service.list());
    expect(seen.length).toBeGreaterThan(1);
  });

  it('批准之後走到結束，沒輪到的節點標成略過', async () => {
    const service = new WorkflowService(disk.deps());
    service.start(linear(), {});
    await waitFor(service, 'waiting_approval');

    service.resume('run-1', { approved: true });
    const done = await waitFor(service, 'done');

    expect(done.nodes.ask.status).toBe('done');
    expect(done.nodes.end.status).toBe('done');
    expect(done.nodes.skipme.status).toBe('skipped');
    expect(done.finishedAt).toBe(1_000);
    expect(done.error).toBeUndefined();
  });

  it('退回之後算失敗，並說明原因', async () => {
    const service = new WorkflowService(disk.deps());
    service.start(linear(), {});
    await waitFor(service, 'waiting_approval');

    service.resume('run-1', { approved: false });
    const failed = await waitFor(service, 'failed');
    expect(failed.error).toBe('批准：已退回');
  });

  it('等待批准的執行，換一個全新的 service 實例仍然接得回去', async () => {
    const first = new WorkflowService(disk.deps());
    first.start(linear(), { task: '建立 hello.txt' });
    await waitFor(first, 'waiting_approval');

    // 模擬 app 重啟：新的 service 只看得到同一份 workflow-runs.json 與 checkpoint 目錄。
    const second = new WorkflowService(disk.deps());
    expect(second.list()[0]).toMatchObject({ status: 'waiting_approval', question: '要保留嗎？' });

    second.resume('run-1', { approved: true });
    const done = await waitFor(second, 'done');
    expect(done.nodes.end.status).toBe('done');
    // 重編的圖是接續的，不會再跑一次實作。
    expect(done.nodes.impl.attempts).toBe(1);
  });

  it('重啟時「執行中」的執行接不回去，標成失敗', async () => {
    const runner = new ScriptedRunner(() => null);
    const first = new WorkflowService(disk.deps({ runnerFactory: () => runner }));
    first.start(linear(), {});
    await until(() => first.list()[0]?.nodes.impl.status === 'running');

    const second = new WorkflowService(disk.deps());
    expect(second.list()[0]).toMatchObject({ status: 'failed', error: 'app 在執行途中關閉了' });
    expect(second.list()[0].nodes.impl.status).toBe('failed');
    expect(second.list()[0].nodes.skipme.status).toBe('skipped');
  });

  it('cancel 會砍掉正在跑的 CLI 並把執行標成已取消', async () => {
    const runner = new ScriptedRunner(() => null);
    const service = new WorkflowService(disk.deps({ runnerFactory: () => runner }));
    service.start(linear(), {});
    await until(() => runner.runs.length === 1);

    service.cancel('run-1');
    expect(runner.runs[0].cancelled).toBe(true);
    expect(service.list()[0]).toMatchObject({ status: 'cancelled', finishedAt: 1_000 });

    // CLI 事後才回報取消，不能把狀態改回去。
    runner.runs[0].emit({ type: 'error', message: '已取消' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.list()[0].status).toBe('cancelled');
  });

  it('壞掉的 workflow-runs.json 當成沒有執行過，不會讓 app 開不起來', () => {
    disk.runs = '{ 不是 JSON';
    expect(new WorkflowService(disk.deps()).list()).toEqual([]);
    disk.runs = '[{"state":{}},{"nope":1}]';
    expect(new WorkflowService(disk.deps()).list()).toEqual([]);
  });
});

describe('內建範本', () => {
  it('實作 → 審查 → 批准：審查一次就過的時候走到批准', async () => {
    const definition = findTemplate('implement-review-approve');
    if (!definition) throw new Error('找不到範本');

    const runner = new ScriptedRunner((task) =>
      agentResult({ text: task.prompt.startsWith('審查') ? '看起來都好\nPASS' : '寫好了' }),
    );
    const service = new WorkflowService(
      disk.deps({ runnerFactory: () => runner, maxTotalCostUsd: 99 }),
    );
    service.start(definition, { task: '建立 hello.txt', cwd: 'D:/tmp' });

    const waiting = await waitFor(service, 'waiting_approval');
    expect(waiting.question).toBe('要保留這次的變更嗎？');
    expect(runner.tasks.map((t) => t.allowEdits)).toEqual([true, false]);
    expect(runner.tasks[0]).toMatchObject({ prompt: '建立 hello.txt', cwd: 'D:/tmp' });
    expect(runner.tasks[1].prompt).toContain('最後一行只輸出 PASS 或 FAIL');
    expect(waiting.nodes.fix.status).toBe('idle');

    service.resume('run-1', { approved: true });
    expect((await waitFor(service, 'done')).nodes.end.status).toBe('done');
  });

  it('審查沒過就走修正，修正接續實作那段對話', async () => {
    const definition = findTemplate('implement-review-approve');
    if (!definition) throw new Error('找不到範本');

    let reviews = 0;
    const runner = new ScriptedRunner((task) => {
      if (!task.prompt.startsWith('審查')) return agentResult({ text: '弄好了', sessionId: 'cli-impl' });
      reviews += 1;
      return agentResult({ text: reviews === 1 ? '少了一行\nFAIL' : '這次好了\nPASS' });
    });
    const service = new WorkflowService(
      disk.deps({ runnerFactory: () => runner, maxTotalCostUsd: 99 }),
    );
    service.start(definition, { task: '建立 hello.txt', cwd: 'D:/tmp' });

    const waiting = await waitFor(service, 'waiting_approval');
    expect(waiting.nodes.fix).toMatchObject({ status: 'done', attempts: 1 });
    const fix = runner.tasks.find((t) => t.prompt.startsWith('審查意見如下'));
    expect(fix).toMatchObject({ prompt: '審查意見如下，請修正：少了一行\nFAIL', resumeId: 'cli-impl' });
  });
});
