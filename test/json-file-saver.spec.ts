import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, StateGraph, Annotation, START, END, interrupt } from '@langchain/langgraph';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { fileCheckpointSaver } from '../src/main/workflow/json-file-saver';
import type { JsonFileSaver } from '../src/main/workflow/json-file-saver';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myterminal-saver-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const thread = (id: string, checkpointId?: string) => ({
  configurable: { thread_id: id, checkpoint_ns: '', ...(checkpointId && { checkpoint_id: checkpointId }) },
});

const meta = (step: number): CheckpointMetadata => ({ source: 'loop', step, parents: {} });

function checkpoint(id: string, values: Record<string, unknown>): Checkpoint {
  return { ...emptyCheckpoint(), id, channel_values: values };
}

async function collect(saver: JsonFileSaver, id: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const tuple of saver.list(thread(id))) {
    ids.push(tuple.config.configurable?.checkpoint_id as string);
  }
  return ids;
}

describe('JsonFileSaver', () => {
  it('put 之後 getTuple 拿得回同一份 checkpoint 與 metadata', async () => {
    const saver = fileCheckpointSaver(dir);
    await saver.put(thread('run-1'), checkpoint('c1', { outputs: { a: { text: '做好了' } } }), meta(0), {});

    const tuple = await saver.getTuple(thread('run-1'));
    expect(tuple?.checkpoint.id).toBe('c1');
    expect(tuple?.checkpoint.channel_values).toEqual({ outputs: { a: { text: '做好了' } } });
    expect(tuple?.metadata).toEqual(meta(0));
    expect(readdirSync(dir)).toEqual(['run-1.json']);
  });

  it('沒指定 checkpoint_id 時拿最新的一份，指定了就拿那一份', async () => {
    const saver = fileCheckpointSaver(dir);
    const first = await saver.put(thread('run-1'), checkpoint('c1', { n: 1 }), meta(0), {});
    await saver.put({ configurable: { ...first.configurable } }, checkpoint('c2', { n: 2 }), meta(1), {});

    expect((await saver.getTuple(thread('run-1')))?.checkpoint.id).toBe('c2');
    expect((await saver.getTuple(thread('run-1', 'c1')))?.checkpoint.id).toBe('c1');
    // c2 是接在 c1 後面的，parentConfig 要指回去。
    expect((await saver.getTuple(thread('run-1')))?.parentConfig?.configurable?.checkpoint_id).toBe(
      'c1',
    );
  });

  it('list 由新到舊，limit 與 before 都管用', async () => {
    const saver = fileCheckpointSaver(dir);
    for (const id of ['c1', 'c2', 'c3']) {
      await saver.put(thread('run-1'), checkpoint(id, {}), meta(0), {});
    }

    expect(await collect(saver, 'run-1')).toEqual(['c3', 'c2', 'c1']);

    const limited: string[] = [];
    for await (const tuple of saver.list(thread('run-1'), { limit: 2 })) {
      limited.push(tuple.config.configurable?.checkpoint_id as string);
    }
    expect(limited).toEqual(['c3', 'c2']);

    const before: string[] = [];
    for await (const tuple of saver.list(thread('run-1'), { before: thread('run-1', 'c3') })) {
      before.push(tuple.config.configurable?.checkpoint_id as string);
    }
    expect(before).toEqual(['c2', 'c1']);
  });

  it('putWrites 的內容會跟著 getTuple 一起回來，同一個 index 不會被覆寫', async () => {
    const saver = fileCheckpointSaver(dir);
    await saver.put(thread('run-1'), checkpoint('c1', {}), meta(0), {});

    await saver.putWrites(thread('run-1', 'c1'), [['outputs', { a: 1 }]], 'task-1');
    await saver.putWrites(thread('run-1', 'c1'), [['outputs', { a: 999 }]], 'task-1');
    await saver.putWrites(thread('run-1', 'c1'), [['lastPort', { a: 'ok' }]], 'task-2');

    const writes = (await saver.getTuple(thread('run-1', 'c1')))?.pendingWrites;
    expect(writes).toEqual([
      ['task-1', 'outputs', { a: 1 }],
      ['task-2', 'lastPort', { a: 'ok' }],
    ]);
  });

  it('不同 thread 各自一個檔案，deleteThread 只刪自己那一個', async () => {
    const saver = fileCheckpointSaver(dir);
    await saver.put(thread('run-1'), checkpoint('c1', {}), meta(0), {});
    await saver.put(thread('run-2'), checkpoint('c1', {}), meta(0), {});
    expect(readdirSync(dir).sort()).toEqual(['run-1.json', 'run-2.json']);

    await saver.deleteThread('run-1');
    expect(readdirSync(dir)).toEqual(['run-2.json']);
    expect(await saver.getTuple(thread('run-1'))).toBeUndefined();
  });

  it('沒有這個 thread 或檔案壞掉時回傳 undefined，不會丟例外', async () => {
    const saver = fileCheckpointSaver(dir);
    expect(await saver.getTuple(thread('nope'))).toBeUndefined();
    expect(await saver.getTuple({ configurable: {} })).toBeUndefined();
    expect(await collect(saver, 'nope')).toEqual([]);
  });
});

describe('JsonFileSaver 的中斷 → 重啟 → 接回去', () => {
  const State = Annotation.Root({
    log: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  });

  const build = (saver: JsonFileSaver) =>
    new StateGraph(State)
      .addNode('ask', () => {
        const answer = interrupt<string, { approved: boolean }>('要保留嗎？');
        return { log: [answer.approved ? '批准' : '退回'] };
      })
      .addNode('done', () => ({ log: ['收尾'] }))
      .addEdge(START, 'ask')
      .addEdge('ask', 'done')
      .addEdge('done', END)
      .compile({ checkpointer: saver });

  it('換一個全新的 saver 實例，靠同一個檔案就能把中斷的圖接回去', async () => {
    const config = { configurable: { thread_id: 'run-1' } };

    // 第一個 saver：跑到 approval 就停住，狀態寫進檔案。
    const paused = (await build(fileCheckpointSaver(dir)).invoke({}, config)) as {
      __interrupt__?: Array<{ value?: unknown }>;
    };
    expect(paused.__interrupt__?.[0]?.value).toBe('要保留嗎？');
    expect(readdirSync(dir)).toEqual(['run-1.json']);

    // 第二個 saver：什麼都不知道，只有那個檔案。
    const resumed = await build(fileCheckpointSaver(dir)).invoke(
      new Command({ resume: { approved: true } }),
      config,
    );
    expect(resumed.log).toEqual(['批准', '收尾']);
  });
});
