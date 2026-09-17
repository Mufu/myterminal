import type {
  AgentNodeConfig,
  ApprovalNodeConfig,
  ConditionNodeConfig,
  NodePosition,
  RunState,
  WorkflowInfo,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPort,
} from '../shared/workflow';
import { NODE_PORTS } from '../shared/workflow';
import type { AgentKind } from '../shared/agent';
import type { BaseShell } from '../shared/profile';
import { CLI_TYPES, TYPE_LABELS as CLI_LABELS } from '../shared/profile';
import { ROLES, findRole } from '../shared/roles';
import type { AppState } from './app-state';
import type { WorkflowEditorModel } from './workflow-editor-model';
import { NODE_HEADER, NODE_WIDTH, PORT_LABELS, PORT_ROW } from './workflow-editor-model';
import { RunOverlay, latestRunFor } from './workflow-run-view';

/**
 * WorkflowEditorView：LabVIEW 風格的畫布。
 * 所有規則 (id、座標、接線合不合法) 都在 WorkflowEditorModel 裡，
 * 這裡只有「怎麼畫」與「滑鼠按下去算什麼」—— 除了下面兩個純函式之外
 * 全部要碰 DOM，所以測試看的是 model 與 e2e/editor.spec.ts。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** svg 給一個夠大的固定尺寸就好，畫布靠平移看不同的地方。*/
const SVG_SIZE = 4000;
/** 連線控制點往外拉多遠：最少這麼多，最多這麼多。*/
const MIN_BEND = 16;
const MAX_BEND = 60;

/** 卡片標頭上的型別。*/
export const TYPE_LABELS: Record<WorkflowNodeType, string> = {
  start: '開始',
  end: '結束',
  agent: 'Agent',
  condition: '條件',
  approval: '批准',
};

/** 屬性面板的「執行者」下拉：四支 CLI，跟新連接對話框同一組。*/
const KIND_OPTIONS = CLI_TYPES.map((cli) => [cli, CLI_LABELS[cli]] as [string, string]);

/** 「手動操作」要在哪個終端機裡開；跟新連接對話框的「基礎 shell」同一組。*/
const SHELL_OPTIONS: Array<[string, string]> = [
  ['powershell', 'PowerShell'],
  ['wsl', 'WSL'],
];

/**
 * 連線是一條立方貝茲：兩端都先水平拉出去，看起來才像接線而不是折線。
 * 控制點跟著水平距離縮放 —— 固定值在節點靠得很近時 (內建範本相鄰兩個節點
 * 只差 20px) 會把線拉成一個 S 形的圈。往回接的線則反過來要拉得更開，
 * 繞出去的那個圈才看得出是一條回頭的線。
 */
export function edgePath(from: NodePosition, to: NodePosition): string {
  const dx = to.x - from.x;
  const bend =
    dx >= 0
      ? Math.min(Math.max(dx / 2, MIN_BEND), MAX_BEND)
      : Math.min(120, 40 + Math.abs(dx) / 4);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** 卡片內文：條件是規則摘要、批准是問題開頭，其餘留給角色標籤或空白。*/
export function nodeSummary(node: WorkflowNode): string {
  switch (node.type) {
    case 'condition': {
      const source = node.config.source || '？';
      return node.config.rule.type === 'lastLineEquals'
        ? `${source} 最後一行 = ${node.config.rule.value}`
        : `${source} 符合 /${node.config.rule.pattern}/`;
    }
    case 'approval':
      return node.config.question.slice(0, 30);
    default:
      return '';
  }
}

/** 畫布上的動作交給誰做；View 自己不知道怎麼存檔也不知道怎麼切畫面。*/
export interface EditorHandlers {
  close(): void;
  save(): void;
  saveAndRun(): void;
  remove(): void;
  /** 下拉選單挑了一個工作流；空字串是「＋ 新工作流」。*/
  pick(id: string): void;
  /** 卡片的「輸出」與屬性面板的「看輸出」：切到那個節點的終端機。*/
  openTerminal(sessionId: string): void;
  /** 屬性面板的「接手」：開一個真的互動式 CLI 接續那段對話。*/
  takeOver(sessionId: string): void;
  /** 「手動操作」：在節點的工作目錄開一個互動式終端機。*/
  openShell(nodeId: string): void;
  /** 「手動操作」：同上，再順手把那支 CLI 叫起來、提示填進輸入面板。*/
  openCli(nodeId: string): void;
  /** 「手動操作」：代好的提示進剪貼簿。*/
  copyPrompt(nodeId: string): void;
  /** 卡片上的批准／退回。*/
  resume(runId: string, approved: boolean): void;
  /** 編輯列上的「取消」。*/
  cancel(run: RunState): void;
}

type Drag =
  | { kind: 'node'; id: string; card: HTMLElement; dx: number; dy: number; x: number; y: number }
  | { kind: 'wire'; from: string; port?: WorkflowPort; path: SVGPathElement; anchor: NodePosition }
  | { kind: 'pan'; dx: number; dy: number };

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

export class WorkflowEditorView {
  private readonly root = $('workflow-editor');
  private readonly canvas = $('editor-canvas');
  private readonly viewport = $('editor-viewport');
  private readonly svg = document.getElementById('editor-edges') as unknown as SVGSVGElement;
  private readonly propsPanel = $('editor-props');
  private readonly errorBox = $('editor-errors');
  private readonly nameInput = $<HTMLInputElement>('editor-name');
  private readonly picker = $<HTMLSelectElement>('editor-workflow');
  private readonly deleteButton = $<HTMLButtonElement>('btn-editor-delete');
  /** 執行檢視：卡片上的狀態與編輯列上那一條，全部由它畫。*/
  private readonly overlay: RunOverlay;

  private pan = { x: 40, y: 40 };
  private infos: WorkflowInfo[] = [];
  /** 屬性面板現在畫的是誰：同一個就不重建，否則使用者打字打到一半輸入框會被換掉。*/
  private propsKey = '';
  /** 拖曳中不重畫，不然手上的卡片會被換掉。*/
  private drag: Drag | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly model: WorkflowEditorModel,
    private readonly handlers: EditorHandlers,
    private readonly state: AppState,
  ) {
    this.overlay = new RunOverlay(
      {
        openTerminal: (sessionId) => this.handlers.openTerminal(sessionId),
        resume: (runId, approved) => this.handlers.resume(runId, approved),
        cancel: (run) => this.handlers.cancel(run),
      },
      $('editor-run'),
    );
    this.svg.setAttribute('width', String(SVG_SIZE));
    this.svg.setAttribute('height', String(SVG_SIZE));
    this.applyPan();

    $('btn-editor-close').addEventListener('click', () => this.handlers.close());
    $('btn-editor-save').addEventListener('click', () => this.handlers.save());
    $('btn-editor-run').addEventListener('click', () => this.handlers.saveAndRun());
    this.deleteButton.addEventListener('click', () => this.handlers.remove());

    $('btn-add-agent').addEventListener('click', () => this.model.addNode('agent'));
    $('btn-add-condition').addEventListener('click', () => this.model.addNode('condition'));
    $('btn-add-approval').addEventListener('click', () => this.model.addNode('approval'));
    $('btn-add-end').addEventListener('click', () => this.model.addNode('end'));

    this.nameInput.addEventListener('input', () => this.model.setName(this.nameInput.value));
    this.picker.addEventListener('change', () => {
      const id = this.picker.value;
      // 先轉回目前這一份；真的載進來時 render() 會再把它轉過去。
      this.syncPicker();
      this.handlers.pick(id);
    });

    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag());
    document.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.model.subscribe(() => this.render());
    // 執行的狀態不是編輯的內容，所以只重畫覆蓋層與屬性面板，
    // 不動 model 也不弄髒它。
    this.state.subscribe(() => {
      this.renderRun();
      this.renderProps();
    });
    this.render();
  }

  /** 下拉選單的內容：內建與自訂各一組，最前面是「新工作流」。*/
  setWorkflows(infos: WorkflowInfo[]): void {
    this.infos = infos;
    this.picker.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '＋ 新工作流';
    this.picker.appendChild(blank);

    for (const [label, builtin] of [
      ['內建', true],
      ['自訂', false],
    ] as const) {
      const group = infos.filter((info) => info.builtin === builtin);
      if (group.length === 0) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const { id, name, description } of group) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        // 說明放在 title 上：下拉太窄寫不下，滑鼠停著就看得到。
        if (description) option.title = description;
        optgroup.appendChild(option);
      }
      this.picker.appendChild(optgroup);
    }
    this.syncPicker();
  }

  /** 驗證或存檔的錯誤；空陣列就收起來。*/
  showErrors(messages: string[]): void {
    clearTimeout(this.errorTimer);
    this.errorBox.textContent = messages.join('\n');
    this.errorBox.hidden = messages.length === 0;
  }

  /** 接不起來的線：講一下原因，三秒後自己消失。*/
  private flash(message: string): void {
    this.showErrors([message]);
    this.errorTimer = setTimeout(() => this.showErrors([]), 3000);
  }

  // ---- 畫面 ----

  private render(): void {
    if (this.drag) return;
    const definition = this.model.definition;
    if (this.nameInput.value !== definition.name) this.nameInput.value = definition.name;
    this.deleteButton.disabled = this.model.source !== 'custom';
    this.syncPicker();
    this.renderNodes();
    this.renderEdges();
    this.renderProps();
    this.renderRun();
  }

  /**
   * 執行檢視：畫布上這份工作流的執行 (還在跑的優先)。
   * 卡片本身是 renderNodes() 畫的，這裡只在上面加／刪自己那幾個元素。
   */
  private renderRun(): void {
    if (this.drag) return;
    const run = latestRunFor(this.state.runs, this.model.definition.id);
    const auth = this.state.cliAuth;
    this.overlay.paintStrip(run, auth);
    for (const card of Array.from(this.viewport.querySelectorAll<HTMLElement>('.wf-node'))) {
      const id = card.dataset.id;
      if (id) this.overlay.paintCard(card, id, run, auth);
    }
  }

  /** 目前執行裡這個節點對應的工作階段；沒有就是 undefined。*/
  private sessionFor(nodeId: string): string | undefined {
    return latestRunFor(this.state.runs, this.model.definition.id)?.nodes[nodeId]?.sessionId;
  }

  private syncPicker(): void {
    const id = this.model.definition.id;
    this.picker.value = this.infos.some((info) => info.id === id) ? id : '';
  }

  private renderNodes(): void {
    for (const card of Array.from(this.viewport.querySelectorAll('.wf-node'))) card.remove();
    for (const node of this.model.definition.nodes) this.viewport.appendChild(this.card(node));
  }

  private card(node: WorkflowNode): HTMLElement {
    const selection = this.model.selection;
    const card = document.createElement('div');
    card.className = 'wf-node';
    card.classList.add(`wf-${node.type}`);
    if (selection?.kind === 'node' && selection.id === node.id) card.classList.add('selected');
    card.dataset.id = node.id;
    card.style.left = `${node.position.x}px`;
    card.style.top = `${node.position.y}px`;
    // 寬度與高度都跟著 portAnchor 的常數走，不然接點會離開卡片。
    card.style.width = `${NODE_WIDTH}px`;
    // 出口一列一格，卡片至少要包得住它們。
    const ports = NODE_PORTS[node.type];
    card.style.minHeight = `${NODE_HEADER + PORT_ROW * Math.max(ports.length, 1)}px`;

    const head = document.createElement('div');
    head.className = 'wf-node-head';
    // 名字沒改過的時候 (開始／結束) 就不要把型別再寫一次。
    const type = TYPE_LABELS[node.type];
    if (type !== node.label) head.appendChild(span('wf-node-type', type));
    head.appendChild(span('wf-node-label', node.label));
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wf-node-body';
    const summary = span('wf-summary', '');
    if (node.type === 'agent') {
      const role = node.config.role ? findRole(node.config.role) : undefined;
      const tag = span('role-tag', role ? role.label : '未設角色');
      if (!role) tag.classList.add('empty');
      summary.append(tag, span('wf-kind', node.config.kind));
      summary.title = `${role ? role.label : '未設角色'} · ${node.config.kind}`;
    } else {
      const text = nodeSummary(node);
      if (text) {
        summary.appendChild(span('wf-note', text));
        // 卡片只有 160 寬，裝不下的用 … 收掉，滑過去看全文。
        summary.title = text;
      }
    }
    body.appendChild(summary);
    // 出口的文字是絕對定位在卡片右緣的，右邊這一欄把位子讓出來，不要疊在一起。
    if (ports.length > 0) body.appendChild(span('wf-port-space', ''));
    card.appendChild(body);

    // 選起來的 agent 卡片直接給手動操作，不必每次都跑去屬性面板。
    if (node.type === 'agent' && card.classList.contains('selected')) {
      card.appendChild(this.manualRow(node.id, node.config.kind));
    }

    if (node.type !== 'start') card.appendChild(this.port(node, 'in'));
    if (node.type === 'start') card.appendChild(this.port(node, undefined));
    for (const port of ports) card.appendChild(this.port(node, port));

    return card;
  }

  /** 卡片上的「手動操作」：三個字以內的短按鈕，全名放在 title 裡。*/
  private manualRow(id: string, kind: AgentKind): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wf-manual';
    row.append(
      cardButton('wf-open-shell', '終端', '在這個節點的工作目錄開終端機', () =>
        this.handlers.openShell(id),
      ),
      cardButton('wf-open-cli', '啟動', `開終端機並啟動 ${CLI_LABELS[kind]}`, () =>
        this.handlers.openCli(id),
      ),
      cardButton('wf-copy-prompt', '複製', '複製這個節點的提示', () =>
        this.handlers.copyPrompt(id),
      ),
    );
    return row;
  }

  /** 接點圓心就是 portAnchor，連線才會剛好接在圓點上。*/
  private port(node: WorkflowNode, port: WorkflowPort | 'in' | undefined): HTMLElement {
    const anchor = this.model.portAnchor(node.id, port);
    const el = document.createElement('span');
    el.className = port === 'in' ? 'wf-port in' : 'wf-port out';
    if (port !== undefined && port !== 'in') {
      el.dataset.port = port;
      const label = document.createElement('i');
      label.className = 'wf-port-label';
      label.textContent = PORT_LABELS[port];
      el.appendChild(label);
    }
    el.style.left = `${anchor.x - node.position.x}px`;
    el.style.top = `${anchor.y - node.position.y}px`;
    return el;
  }

  private renderEdges(): void {
    this.svg.textContent = '';
    const selection = this.model.selection;
    this.model.definition.edges.forEach((edge, index) => {
      const d = edgePath(this.anchor(edge.from, edge.port), this.anchor(edge.to, 'in'));
      const hit = pathEl(d, 'wf-edge-hit');
      hit.dataset.index = String(index);
      const line = pathEl(d, 'wf-edge');
      if (selection?.kind === 'edge' && selection.index === index) line.classList.add('selected');
      this.svg.append(hit, line);
    });
  }

  /** 拖曳中的節點還沒寫回 model，連線要跟著手上的位置走。*/
  private anchor(nodeId: string, port: WorkflowPort | 'in' | undefined): NodePosition {
    const anchor = this.model.portAnchor(nodeId, port);
    const drag = this.drag;
    if (!drag || drag.kind !== 'node' || drag.id !== nodeId) return anchor;
    const node = this.model.node(nodeId);
    if (!node) return anchor;
    return { x: anchor.x + drag.x - node.position.x, y: anchor.y + drag.y - node.position.y };
  }

  // ---- 滑鼠 ----

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as Element;

    const out = target.closest<HTMLElement>('.wf-port.out');
    if (out) return this.startWire(event, out);

    const card = target.closest<HTMLElement>('.wf-node');
    if (card?.dataset.id) return this.startNodeDrag(event, card.dataset.id);

    const edge = target.closest<SVGPathElement>('.wf-edge-hit');
    if (edge?.dataset.index) {
      this.model.select({ kind: 'edge', index: Number(edge.dataset.index) });
      return;
    }

    this.model.select(null);
    this.drag = { kind: 'pan', dx: event.clientX - this.pan.x, dy: event.clientY - this.pan.y };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private startNodeDrag(event: PointerEvent, id: string): void {
    // 先選起來 (會整個重畫)，再去拿重畫之後的那張卡片。
    this.model.select({ kind: 'node', id });
    const card = this.viewport.querySelector<HTMLElement>(`.wf-node[data-id="${id}"]`);
    const node = this.model.node(id);
    if (!card || !node) return;
    const point = this.toCanvas(event);
    this.drag = {
      kind: 'node',
      id,
      card,
      dx: point.x - node.position.x,
      dy: point.y - node.position.y,
      x: node.position.x,
      y: node.position.y,
    };
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private startWire(event: PointerEvent, portEl: HTMLElement): void {
    const card = portEl.closest<HTMLElement>('.wf-node');
    const from = card?.dataset.id;
    if (!from) return;
    const port = portEl.dataset.port as WorkflowPort | undefined;
    const anchor = this.model.portAnchor(from, port);
    const path = pathEl(edgePath(anchor, anchor), 'wf-edge temp');
    path.id = 'wf-edge-temp';
    this.svg.appendChild(path);
    this.drag = { kind: 'wire', from, port, path, anchor };
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'pan') {
      this.pan = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
      this.applyPan();
      return;
    }
    if (drag.kind === 'wire') {
      drag.path.setAttribute('d', edgePath(drag.anchor, this.toCanvas(event)));
      return;
    }
    const point = this.toCanvas(event);
    drag.x = point.x - drag.dx;
    drag.y = point.y - drag.dy;
    drag.card.style.left = `${drag.x}px`;
    drag.card.style.top = `${drag.y}px`;
    this.renderEdges();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;

    if (drag.kind === 'node') {
      // 只是點一下 (位置沒變) 就不要把工作流弄髒。
      const node = this.model.node(drag.id);
      const moved = node && (node.position.x !== drag.x || node.position.y !== drag.y);
      if (moved) this.model.moveNode(drag.id, { x: drag.x, y: drag.y });
      else this.render();
      return;
    }

    if (drag.kind === 'wire') {
      drag.path.remove();
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const to = under?.closest<HTMLElement>('.wf-node')?.dataset.id;
      const error = to ? this.model.connect(drag.from, drag.port, to) : null;
      if (error) this.flash(error);
      this.render();
    }
  }

  private cancelDrag(): void {
    if (this.drag?.kind === 'wire') this.drag.path.remove();
    this.drag = null;
    this.render();
  }

  private applyPan(): void {
    this.viewport.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
  }

  /** 螢幕座標換成畫布座標。*/
  private toCanvas(event: PointerEvent): NodePosition {
    const rect = this.viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.root.hidden) return;
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const focused = document.activeElement?.tagName ?? '';
    if (focused === 'INPUT' || focused === 'TEXTAREA' || focused === 'SELECT') return;
    const selection = this.model.selection;
    if (!selection) return;
    event.preventDefault();
    if (selection.kind === 'node') this.model.removeNode(selection.id);
    else this.model.removeEdge(selection.index);
  }

  // ---- 屬性面板 ----

  private renderProps(): void {
    const selection = this.model.selection;
    const key = !selection
      ? 'none'
      : selection.kind === 'node'
        ? // 工作階段也算進鑰匙：節點跑起來之後面板才長得出「接手」。
          `node:${selection.id}:${this.sessionFor(selection.id) ?? ''}`
        : `edge:${selection.index}`;
    if (key === this.propsKey) return;
    this.propsKey = key;
    this.propsPanel.textContent = '';

    if (!selection) {
      this.propsPanel.appendChild(
        note('拖拉節點換位置；從右側的出口拉到另一個節點的左側入口就是一條連線；選起來按 Delete 刪掉。'),
      );
      return;
    }

    if (selection.kind === 'edge') {
      const edge = this.model.definition.edges[selection.index];
      if (!edge) return;
      const port = edge.port ? PORT_LABELS[edge.port] : '—';
      this.propsPanel.append(
        title(`連線：${edge.from}（${port}）→ ${edge.to}`),
        note('按 Delete 刪掉這條連線；同一個出口再拉一次就是改接。'),
      );
      return;
    }

    const node = this.model.node(selection.id);
    if (!node) return;
    const id = node.id;

    this.propsPanel.append(
      title(`${TYPE_LABELS[node.type]}：${id}`),
      note(`在提示裡用 {{${id}.text}} 取得它的輸出`),
      row('名稱', input(node.label, (value) => this.model.updateNode(id, { label: value }), 'props-label')),
    );

    if (node.type === 'agent') this.agentProps(node.id, node.config);
    if (node.type === 'condition') this.conditionProps(node.id, node.config);
    if (node.type === 'approval') this.approvalProps(node.id, node.config);
  }

  private agentProps(id: string, config: AgentNodeConfig): void {
    const kind = select(
      KIND_OPTIONS,
      config.kind,
      (value) => {
        this.model.updateNode(id, { config: { kind: value as AgentKind } });
        // 「開終端機並啟動 <CLI>」那顆按鈕上的名字要跟著換。
        this.propsKey = '';
        this.renderProps();
      },
      'props-kind',
    );

    const role = select(
      [['', '無'], ...ROLES.map((r) => [r.id, r.label] as [string, string])],
      config.role ?? '',
      (value) => {
        const info = findRole(value);
        // 換角色順便把「允許修改檔案」跳到那個角色的預設值，跟新連接對話框一樣。
        this.model.updateNode(id, {
          config: info
            ? { role: info.id, allowEdits: info.defaultAllowEdits }
            : { role: undefined },
        });
        this.propsKey = '';
        this.renderProps();
      },
      'props-role',
    );

    const others = this.model.definition.nodes
      .filter((n) => n.type === 'agent' && n.id !== id)
      .map((n) => [n.id, n.id] as [string, string]);

    this.propsPanel.append(
      row('執行者', kind),
      row('角色', role),
      row(
        '提示',
        textarea(
          config.prompt,
          (value) => this.model.updateNode(id, { config: { prompt: value } }),
          'props-prompt',
        ),
      ),
      note('可用 {{params.task}}、{{params.cwd}}、{{<節點id>.text}}'),
      row(
        '工作目錄',
        input(config.cwd ?? '', (value) => this.model.updateNode(id, { config: { cwd: value } }), 'props-cwd'),
      ),
      check(
        '允許修改檔案',
        config.allowEdits,
        (value) => this.model.updateNode(id, { config: { allowEdits: value } }),
        'props-allow-edits',
      ),
      row(
        '接續對話',
        select(
          [['', '無'], ...others],
          config.resumeFrom ?? '',
          (value) => this.model.updateNode(id, { config: { resumeFrom: value || undefined } }),
          'props-resume-from',
        ),
      ),
      row(
        '最多幾次',
        number(
          config.maxAttempts,
          (value) => this.model.updateNode(id, { config: { maxAttempts: value } }),
          'props-max-attempts',
        ),
      ),
      row(
        '逾時 (秒)',
        number(
          config.timeoutSec,
          (value) => this.model.updateNode(id, { config: { timeoutSec: value } }),
          'props-timeout',
        ),
      ),
    );

    this.propsPanel.append(
      title('手動操作'),
      row(
        '終端機',
        select(
          SHELL_OPTIONS,
          config.shell ?? 'powershell',
          (value) => this.model.updateNode(id, { config: { shell: value as BaseShell } }),
          'props-shell',
        ),
      ),
      actions(
        [
          ['props-open-shell', '開終端機', () => this.handlers.openShell(id)],
          [
            'props-open-cli',
            `開終端機並啟動 ${CLI_LABELS[config.kind]}`,
            () => this.handlers.openCli(id),
          ],
          ['props-copy-prompt', '複製提示', () => this.handlers.copyPrompt(id)],
        ],
        'stack',
      ),
      note('在這個節點的工作目錄開一個互動式終端機，自己下 prompt。提示會先填進「輸入字」面板，看過再按送出。'),
    );

    // 這個節點在目前這次執行裡已經有工作階段了：可以去看它，也可以接手。
    const sessionId = this.sessionFor(id);
    if (!sessionId) return;
    this.propsPanel.append(
      actions([
        ['props-takeover', '接手', () => this.handlers.takeOver(sessionId)],
        ['props-open-terminal', '看輸出', () => this.handlers.openTerminal(sessionId)],
      ]),
      note('無介面執行中的節點沒辦法追問；要接著問就用「接手」開一個真的互動式 CLI。'),
    );
  }

  private conditionProps(id: string, config: ConditionNodeConfig): void {
    const agents = this.model.definition.nodes
      .filter((n) => n.type === 'agent')
      .map((n) => [n.id, n.id] as [string, string]);

    const rule = config.rule;
    const value = rule.type === 'lastLineEquals' ? rule.value : rule.pattern;

    this.propsPanel.append(
      row(
        '看誰的輸出',
        select(
          [['', '（未選）'], ...agents],
          config.source,
          (next) => this.model.updateNode(id, { config: { source: next } }),
          'props-source',
        ),
      ),
      row(
        '判斷',
        select(
          [
            ['lastLineEquals', '最後一行等於'],
            ['regex', '符合正規式'],
          ],
          rule.type,
          (next) => {
            this.model.updateNode(id, {
              config: {
                rule:
                  next === 'regex'
                    ? { type: 'regex', pattern: value }
                    : { type: 'lastLineEquals', value },
              },
            });
            this.propsKey = '';
            this.renderProps();
          },
          'props-rule',
        ),
      ),
      row(
        rule.type === 'regex' ? '正規式' : '要等於',
        input(
          value,
          (next) =>
            this.model.updateNode(id, {
              config: {
                rule:
                  rule.type === 'regex'
                    ? { type: 'regex', pattern: next }
                    : { type: 'lastLineEquals', value: next },
              },
            }),
          'props-rule-value',
        ),
      ),
    );
  }

  private approvalProps(id: string, config: ApprovalNodeConfig): void {
    this.propsPanel.append(
      row(
        '問題',
        textarea(
          config.question,
          (value) => this.model.updateNode(id, { config: { question: value } }),
          'props-question',
        ),
      ),
      note('執行到這裡會停下來，在右側清單按批准或退回。'),
    );
  }
}

// ---- 小零件 ----

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function pathEl(d: string, className: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', className);
  return path;
}

function title(text: string): HTMLElement {
  return span('props-title', text);
}

function note(text: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = 'props-note';
  el.textContent = text;
  return el;
}

/**
 * 屬性面板下方的一排按鈕 (接手／看輸出)。
 * 'stack' 是直的一疊 —— 「開終端機並啟動 OpenCode」那種長標籤排不進一列。
 */
function actions(
  buttons: Array<[id: string, label: string, onClick: () => void]>,
  layout?: 'stack',
): HTMLDivElement {
  const el = document.createElement('div');
  el.className = layout ? `props-actions ${layout}` : 'props-actions';
  for (const [id, text, onClick] of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.textContent = text;
    button.addEventListener('click', onClick);
    el.appendChild(button);
  }
  return el;
}

/**
 * 卡片上的按鈕要吃掉 pointerdown —— 畫布是用它開始拖曳的，
 * 不擋的話按一下會順便把節點拖走 (跟 RunOverlay 那幾顆同一個理由)。
 */
function cardButton(
  className: string,
  text: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  el.title = title;
  el.addEventListener('pointerdown', (event) => event.stopPropagation());
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const el = document.createElement('label');
  el.className = 'props-row';
  el.append(span('props-label', label), control);
  return el;
}

function check(
  label: string,
  value: boolean,
  onChange: (value: boolean) => void,
  id: string,
): HTMLLabelElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = id;
  box.checked = value;
  box.addEventListener('change', () => onChange(box.checked));
  const el = document.createElement('label');
  el.className = 'props-row check';
  el.append(box, span('props-label', label));
  return el;
}

function input(value: string, onInput: (value: string) => void, id: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.id = id;
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function textarea(value: string, onInput: (value: string) => void, id: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.rows = 4;
  el.id = id;
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** 留白就是「用預設值」，所以空字串要變回 undefined。*/
function number(
  value: number | undefined,
  onInput: (value: number | undefined) => void,
  id: string,
): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'number';
  el.id = id;
  el.min = '1';
  el.value = value === undefined ? '' : String(value);
  el.placeholder = '預設';
  el.addEventListener('input', () => onInput(el.value === '' ? undefined : Number(el.value)));
  return el;
}

function select(
  options: Array<[value: string, label: string]>,
  value: string,
  onChange: (value: string) => void,
  id: string,
): HTMLSelectElement {
  const el = document.createElement('select');
  el.id = id;
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    el.appendChild(option);
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
