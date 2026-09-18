import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { TEMPLATES, findTemplate, templateInfos } from '../src/main/workflow/templates';
import { compile } from '../src/main/workflow/graph-compiler';
import { WorkflowService } from '../src/main/workflow/workflow-service';
import { fileCheckpointSaver } from '../src/main/workflow/json-file-saver';
import { DEFAULT_PARAMS, validateWorkflow } from '../src/shared/workflow';
import type { RunState } from '../src/shared/workflow';
import {
  FakeSessions,
  ManualTimers,
  ScriptedRunner,
  agentResult,
  until,
} from './fakes/fake-workflow';

/**
 * 內建範本的守門：每一份都要驗得過、編得起來、畫得開
 * (沒有兩個節點疊在一起)，而且參照 (條件來源、resumeFrom) 都指得到人。
 * 真的呼叫 CLI 的執行不在這裡，用假的 runner 就夠看出圖接得對不對。
 */

describe('內建範本', () => {
  it('八份，順序固定，實作 → 審查 → 批准 排第一個', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'implement-review-approve',
      'software-dev',
      'bug-fix',
      'code-review',
      'write-tests',
      'refactor',
      'plan-only',
      'cross-review',
    ]);
  });

  it('每一份都有 id、名稱與一句說明，而且 id 不重複', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEMPLATES) {
      expect(template.name.trim()).not.toBe('');
      expect(template.description?.trim()).toBeTruthy();
    }
  });

  it('templateInfos 把說明一起帶出去', () => {
    expect(templateInfos()[0]).toEqual({
      id: 'implement-review-approve',
      name: '實作 → 審查 → 批准',
      description: TEMPLATES[0].description,
      params: DEFAULT_PARAMS,
      builtin: true,
    });
  });

  for (const template of TEMPLATES) {
    describe(template.id, () => {
      it('validateWorkflow 沒有任何錯', () => {
        expect(validateWorkflow(template)).toEqual([]);
      });

      it('節點 id 不重複，也沒有兩個節點疊在同一個位置', () => {
        const ids = template.nodes.map((node) => node.id);
        expect(new Set(ids).size).toBe(ids.length);
        const spots = template.nodes.map((node) => `${node.position.x},${node.position.y}`);
        expect(new Set(spots).size).toBe(spots.length);
      });

      it('條件的來源是 agent 節點，resumeFrom 指到同一支 CLI 的 agent 節點', () => {
        const byId = new Map(template.nodes.map((node) => [node.id, node]));
        for (const node of template.nodes) {
          if (node.type === 'condition') {
            expect(byId.get(node.config.source)?.type).toBe('agent');
          }
          if (node.type !== 'agent' || node.config.resumeFrom === undefined) continue;
          const target = byId.get(node.config.resumeFrom);
          expect(target?.type).toBe('agent');
          if (target?.type !== 'agent') continue;
          expect(target.config.kind).toBe(node.config.kind);
        }
      });

      it('只吃 task 與 cwd 兩個啟動參數，agent 節點都有工作目錄', () => {
        // 明寫出來，畫布的「啟動參數」面板才看得到。
        expect(template.params).toEqual(DEFAULT_PARAMS);
        for (const node of template.nodes) {
          if (node.type !== 'agent') continue;
          expect(node.config.cwd).toBe('{{params.cwd}}');
          const params = [...node.config.prompt.matchAll(/\{\{params\.(\w+)\}\}/g)].map(
            (m) => m[1],
          );
          for (const name of params) expect(['task', 'cwd']).toContain(name);
        }
      });

      it('編譯得起來', async () => {
        await expect(
          compile(template, {
            runnerFactory: () => new ScriptedRunner(() => agentResult()),
            sessions: new FakeSessions(),
            checkpointer: new MemorySaver(),
            budget: {},
            params: {},
            timers: new ManualTimers(),
          }),
        ).resolves.toBeDefined();
      });
    });
  }
});

describe('程式碼審查（唯讀）跑一次', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'myterminal-templates-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('一個節點跑完就結束，{{params.task}} 有代進去', async () => {
    const definition = findTemplate('code-review');
    if (!definition) throw new Error('找不到範本');

    const runner = new ScriptedRunner(() => agentResult({ text: '沒什麼問題\nPASS' }));
    let runs: string | null = null;
    const service = new WorkflowService({
      runnerFactory: () => runner,
      sessions: new FakeSessions(),
      checkpointer: async () => fileCheckpointSaver(dir),
      read: () => runs,
      write: (content) => {
        runs = content;
      },
      timers: new ManualTimers(),
      newRunId: () => 'run-1',
      exists: () => true,
    });
    service.start(definition, { task: 'src/main 的錯誤處理', cwd: 'D:/work' });

    const done: RunState = await (async () => {
      await until(() => service.list()[0]?.status === 'done');
      return service.list()[0];
    })();

    expect(done.nodes.reviewer.status).toBe('done');
    expect(done.nodes.end.status).toBe('done');
    expect(runner.tasks).toHaveLength(1);
    expect(runner.tasks[0]).toMatchObject({ cwd: 'D:/work', permission: 'readonly' });
    expect(runner.tasks[0].prompt).toContain('審查「src/main 的錯誤處理」指定的範圍');
    expect(runner.tasks[0].prompt).toContain('最後一行只輸出 PASS 或 FAIL');
  });
});
