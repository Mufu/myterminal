import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/shared/template';

/** 樣板替換本身：解析得出來就代進去，解析不出來原樣留著。*/
describe('renderTemplate', () => {
  const resolve = (head: string, field: string): string | undefined =>
    head === 'params' && field === 'task' ? '寫檔' : undefined;

  it('代入 resolve 給的字', () => {
    expect(renderTemplate('做：{{params.task}}', resolve)).toBe('做：寫檔');
  });

  it('解析不出來的原樣留著', () => {
    expect(renderTemplate('[{{params.none}}][{{a.text}}]', resolve)).toBe(
      '[{{params.none}}][{{a.text}}]',
    );
  });

  it('沒有點的、或跨越括號的都不是樣板', () => {
    expect(renderTemplate('{{weird}} {{ params.task }}', resolve)).toBe('{{weird}} 寫檔');
  });

  it('空字串是有效的替換，不會退回原樣', () => {
    expect(renderTemplate('[{{params.task}}]', () => '')).toBe('[]');
  });
})
