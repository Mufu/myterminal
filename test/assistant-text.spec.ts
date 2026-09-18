import { describe, it, expect, beforeEach } from 'vitest';
import { AppState } from '../src/renderer/app-state';
import { buildAssistantContext, renderAssistantText } from '../src/renderer/assistant-text';
import type { SessionInfo } from '../src/shared/session';
import type { RunState } from '../src/shared/workflow';
import type { CliAuthStatus } from '../src/shared/cli-auth';

describe('renderAssistantText', () => {
  it('HTML 一律跳脫，不讓回答帶標籤進畫面', () => {
    expect(renderAssistantText('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  it('引號也跳脫 (屬性值裡會用到)', () => {
    expect(renderAssistantText('他說 "好" & 走了')).toBe('<p>他說 &quot;好&quot; &amp; 走了</p>');
  });

  it('**粗體** 與 `程式碼`', () => {
    expect(renderAssistantText('按 **建立**，或打 `claude --resume`')).toBe(
      '<p>按 <strong>建立</strong>，或打 <code>claude --resume</code></p>',
    );
  });

  it('程式碼裡的星號不算粗體', () => {
    expect(renderAssistantText('`a ** b`')).toBe('<p><code>a ** b</code></p>');
  });

  it('- 開頭的連續幾行是項目清單', () => {
    expect(renderAssistantText('- 一\n- 二')).toBe('<ul><li>一</li><li>二</li></ul>');
  });

  it('1. 開頭的連續幾行是編號清單', () => {
    expect(renderAssistantText('1. 按「新連接」\n2. 選「WSL」')).toBe(
      '<ol><li>按「新連接」</li><li>選「WSL」</li></ol>',
    );
  });

  it('同一段裡的換行變成 <br>，空行分段', () => {
    expect(renderAssistantText('第一行\n第二行\n\n第二段')).toBe(
      '<p>第一行<br>第二行</p><p>第二段</p>',
    );
  });

  it('清單前後的說明各自成段', () => {
    expect(renderAssistantText('步驟：\n1. 甲\n2. 乙\n完成。')).toBe(
      '<p>步驟：</p><ol><li>甲</li><li>乙</li></ol><p>完成。</p>',
    );
  });

  it('空白字串就是空的', () => {
    expect(renderAssistantText('')).toBe('');
    expect(renderAssistantText('\n\n')).toBe('');
  });
});

const session = (name: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: name,
  name,
  type: 'powershell',
  state: 'running',
  logging: false,
  ...over,
});

const run = (over: Partial<RunState> = {}): RunState => ({
  runId: 'r1',
  workflowId: 'w1',
  name: '實作 → 審查 → 批准',
  status: 'running',
  params: {},
  nodes: {},
  totalCostUsd: 0,
  startedAt: 0,
  ...over,
});

const auth = (): CliAuthStatus => ({
  claude: { loggedIn: true, mode: 'subscription', plan: 'max', label: 'Max 訂閱' },
  codex: { loggedIn: false, mode: 'unknown', label: '未登入' },
  muse: { loggedIn: false, mode: 'unknown', label: '未登入' },
  opencode: { loggedIn: true, mode: 'api', label: 'API 金鑰' },
});

let state: AppState;

beforeEach(() => {
  state = new AppState();
});

describe('buildAssistantContext', () => {
  it('什麼都沒有時只寫畫面、沒有工作階段、四支 CLI 還在偵測', () => {
    expect(buildAssistantContext(state)).toBe(
      [
        '[目前狀態]',
        '畫面：終端機',
        '工作階段：無',
        'CLI：Claude · 偵測中…、Codex · 偵測中…、Muse · 偵測中…、OpenCode · 偵測中…',
        '工作流執行：無',
      ].join('\n'),
    );
  });

  it('工作階段寫成「名稱（類型, 執行中/已結束）」，並標出作用中的那個', () => {
    state.setSessions([
      session('PowerShell 1'),
      session('實作', { type: 'agent', state: 'exited' }),
    ]);
    state.setActive('PowerShell 1');

    const context = buildAssistantContext(state);
    expect(context).toContain('工作階段（2）：PowerShell 1（PowerShell, 執行中）、實作（Agent, 已結束）');
    expect(context).toContain('作用中：PowerShell 1');
  });

  it('工作階段最多列十個，總數照實寫', () => {
    state.setSessions(Array.from({ length: 12 }, (_, i) => session(`S${i + 1}`)));
    const line = buildAssistantContext(state)
      .split('\n')
      .find((l) => l.startsWith('工作階段'));

    expect(line).toContain('工作階段（12）：');
    expect(line).toContain('S10（PowerShell, 執行中）');
    expect(line).not.toContain('S11');
  });

  it('畫布開著時畫面寫「畫布」', () => {
    state.showEditor();
    expect(buildAssistantContext(state)).toContain('畫面：畫布');
  });

  it('CLI 那一行跟頁尾的晶片同一份字', () => {
    state.setCliAuth(auth());
    expect(buildAssistantContext(state)).toContain(
      'CLI：Claude · Max 訂閱、Codex · 未登入、Muse · 未登入、OpenCode · API 金鑰',
    );
  });

  it('工作流執行按狀態數，同狀態的併在一起', () => {
    state.setRuns([
      run(),
      run({ runId: 'r2', status: 'waiting_approval' }),
      run({ runId: 'r3', status: 'running' }),
    ]);
    expect(buildAssistantContext(state)).toContain('工作流執行：執行中 2、等待批准 1');
  });

  it('不帶終端機內容，也不帶任何金鑰', () => {
    state.setSessions([session('PowerShell 1')]);
    state.setCliAuth(auth());
    const context = buildAssistantContext(state);

    expect(context).not.toMatch(/sk-|API_KEY/);
    // 每一行都是短摘要，不會夾帶輸出。
    for (const line of context.split('\n')) expect(line.length).toBeLessThan(400);
  });
});
