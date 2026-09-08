import type { AppState } from './app-state';
import type { ICommand } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

export interface ToolbarCommands {
  newConnection: ICommand;
  toggleInput: ICommand;
  copy: ICommand;
  paste: ICommand;
  toggleLog: ICommand;
  clear: ICommand;
  send: ICommand;
}

/**
 * Toolbar：只做兩件事 —— 把點擊接到 Command，以及依 AppState 更新按鈕外觀。
 * 所有實際行為都在 Command 裡，所以這個檔案不需要單元測試。
 */
export class Toolbar {
  private readonly logButton = $<HTMLButtonElement>('btn-log');
  private readonly needSession: HTMLButtonElement[];

  constructor(
    private readonly state: AppState,
    commands: ToolbarCommands,
  ) {
    const bind = (id: string, command: ICommand): HTMLButtonElement => {
      const button = $<HTMLButtonElement>(id);
      button.addEventListener('click', () => void command.execute());
      return button;
    };

    bind('btn-new', commands.newConnection);
    bind('btn-input', commands.toggleInput);
    bind('btn-send', commands.send);

    this.needSession = [
      bind('btn-copy', commands.copy),
      bind('btn-paste', commands.paste),
      bind('btn-log', commands.toggleLog),
      bind('btn-clear', commands.clear),
    ];

    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const session = this.state.activeSession();
    for (const button of this.needSession) button.disabled = session === null;
    this.logButton.classList.toggle('on', session?.logging === true);
    this.logButton.textContent = session?.logging ? '紀錄中' : '紀錄';
    $<HTMLButtonElement>('btn-input').classList.toggle('on', this.state.inputPanelVisible);
  }
}
