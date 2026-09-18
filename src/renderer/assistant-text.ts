import type { AppState } from './app-state';
import { chipLabel } from './cli-status-view';
import { runStatusLabel } from './workflow-list-view';
import { CLI_IDS } from '../shared/cli-auth';
import { TYPE_LABELS } from '../shared/profile';
import type { RunStatus } from '../shared/workflow';

/** 助理那兩個純函式：回答怎麼變成 HTML，以及畫面狀態怎麼變成一段摘要。*/

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const escape = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/**
 * 行內語法：`程式碼` 與 **粗體**。一次掃過去，所以程式碼裡的星號不會被當成粗體。
 * 進來的字已經跳脫過了。
 */
const inline = (text: string): string =>
  text.replace(/`([^`]+)`|\*\*([^*]+)\*\*/g, (_match, code?: string, bold?: string) =>
    code === undefined ? `<strong>${bold}</strong>` : `<code>${code}</code>`,
  );

const BULLET = /^\s*[-*]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

/**
 * 助理的回答 -> HTML。刻意只認四種東西：粗體、行內程式碼、項目清單、編號清單，
 * 其餘照原樣顯示 (空行分段，段內換行是 <br>)。
 *
 * **一切先跳脫再拼**，回答裡的 `<script>` 只會變成畫面上的字 ——
 * 這是唯一會把模型輸出放進 innerHTML 的地方，所以規則寫在這個純函式裡，測得到。
 */
export function renderAssistantText(text: string): string {
  const out: string[] = [];
  /** 還沒收尾的那一段：清單項目或一般文字行。*/
  let kind: 'ul' | 'ol' | 'p' | null = null;
  let items: string[] = [];

  const flush = (): void => {
    if (kind === 'p') out.push(`<p>${items.join('<br>')}</p>`);
    else if (kind) out.push(`<${kind}>${items.map((i) => `<li>${i}</li>`).join('')}</${kind}>`);
    kind = null;
    items = [];
  };

  const push = (next: 'ul' | 'ol' | 'p', item: string): void => {
    if (kind !== next) flush();
    kind = next;
    items.push(item);
  };

  for (const raw of escape(text).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (BULLET.test(line)) push('ul', inline(line.replace(BULLET, '')));
    else if (NUMBER.test(line)) push('ol', inline(line.replace(NUMBER, '')));
    else push('p', inline(line));
  }
  flush();
  return out.join('');
}

/** 工作階段最多列幾個 —— 再多也只是讓提示變長。*/
const MAX_SESSIONS = 10;

/**
 * 問題前面附的畫面摘要，讓助理答得出「我現在這個畫面…」。
 *
 * 只放看得見的東西：哪個畫面、有哪些工作階段、四支 CLI 的登入狀態、
 * 工作流執行各有幾個。**不放終端機內容，也不放任何金鑰。**
 */
export function buildAssistantContext(state: AppState): string {
  const lines = ['[目前狀態]', `畫面：${state.view === 'editor' ? '畫布' : '終端機'}`];

  const sessions = state.sessions;
  if (sessions.length === 0) lines.push('工作階段：無');
  else {
    const listed = sessions
      .slice(0, MAX_SESSIONS)
      .map(
        (s) =>
          `${s.name}（${TYPE_LABELS[s.type]}, ${s.state === 'running' ? '執行中' : '已結束'}）`,
      );
    lines.push(`工作階段（${sessions.length}）：${listed.join('、')}`);
    const active = state.activeSession();
    if (active) lines.push(`作用中：${active.name}`);
  }

  const settings = state.cliSettings;
  const chips = CLI_IDS.map((id) =>
    chipLabel(TYPE_LABELS[id], state.cliAuth?.[id], settings?.[id], state.cliProbing),
  );
  lines.push(`CLI：${chips.join('、')}`);

  const counts = new Map<RunStatus, number>();
  for (const run of state.runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const runs = [...counts].map(([status, n]) => `${runStatusLabel(status)} ${n}`);
  lines.push(`工作流執行：${runs.length > 0 ? runs.join('、') : '無'}`);

  return lines.join('\n');
}
