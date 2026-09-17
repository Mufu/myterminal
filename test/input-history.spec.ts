import { describe, it, expect, beforeEach } from 'vitest';
import {
  InputHistory,
  MAX_HISTORY,
  atFirstLine,
  atLastLine,
} from '../src/renderer/input-history';

let history: InputHistory;

beforeEach(() => {
  history = new InputHistory();
});

describe('InputHistory 的草稿', () => {
  it('沒打過字的工作階段是空的', () => {
    expect(history.text('s1')).toBe('');
  });

  it('每個工作階段記著自己還沒送出的字', () => {
    history.setText('s1', '給第一個的');
    history.setText('s2', '給第二個的');
    expect(history.text('s1')).toBe('給第一個的');
    expect(history.text('s2')).toBe('給第二個的');
  });
});

describe('InputHistory 的送出歷史', () => {
  it('送出之後輸入區回到空白，↑ 叫得回剛才那一筆', () => {
    history.push('s1', 'echo one');
    expect(history.text('s1')).toBe('');
    expect(history.recall('s1', -1)).toBe('echo one');
  });

  it('↑ 往舊的走，↓ 往新的走，最後回到還沒送出的那一格', () => {
    history.push('s1', 'first');
    history.push('s1', 'second');
    history.setText('s1', '寫到一半的');

    expect(history.recall('s1', -1)).toBe('second');
    expect(history.recall('s1', -1)).toBe('first');
    // 已經是最舊的了
    expect(history.recall('s1', -1)).toBeNull();
    expect(history.recall('s1', 1)).toBe('second');
    expect(history.recall('s1', 1)).toBe('寫到一半的');
    expect(history.recall('s1', 1)).toBeNull();
  });

  it('沒有歷史時 ↑ ↓ 都沒得走', () => {
    expect(history.recall('s1', -1)).toBeNull();
    history.setText('s1', 'x');
    expect(history.recall('s1', -1)).toBeNull();
    expect(history.recall('s1', 1)).toBeNull();
  });

  /** 叫回來之後打字改的是副本，送出過的原文不能被動到。*/
  it('叫回舊訊息再改，改的是副本', () => {
    history.push('s1', '原本那一句');
    history.recall('s1', -1);
    history.setText('s1', '原本那一句（改過）');

    expect(history.text('s1')).toBe('原本那一句（改過）');
    expect(history.recall('s1', 1)).toBe('');
    expect(history.recall('s1', -1)).toBe('原本那一句（改過）');

    // 再送一次之後副本丟掉，歷史裡還是原文。
    history.push('s1', '別的');
    expect(history.recall('s1', -1)).toBe('別的');
    expect(history.recall('s1', -1)).toBe('原本那一句');
  });

  it('歷史是每個工作階段各自一份', () => {
    history.push('s1', 'a');
    expect(history.recall('s2', -1)).toBeNull();
  });

  it(`最多留 ${MAX_HISTORY} 筆，最舊的被擠掉`, () => {
    for (let i = 1; i <= MAX_HISTORY + 5; i += 1) history.push('s1', `第 ${i} 句`);

    const seen: string[] = [];
    for (let recalled = history.recall('s1', -1); recalled !== null; ) {
      seen.push(recalled);
      recalled = history.recall('s1', -1);
    }
    expect(seen).toHaveLength(MAX_HISTORY);
    expect(seen[0]).toBe(`第 ${MAX_HISTORY + 5} 句`);
    expect(seen.at(-1)).toBe('第 6 句');
  });
});

describe('游標在不在第一行 / 最後一行', () => {
  it('單行的時候兩邊都算', () => {
    expect(atFirstLine('abc', 2)).toBe(true);
    expect(atLastLine('abc', 2)).toBe(true);
  });

  it('多行時只有真的在那一行才算', () => {
    const text = 'one\ntwo\nthree';
    // 第一行裡
    expect(atFirstLine(text, 1)).toBe(true);
    expect(atLastLine(text, 1)).toBe(false);
    // 中間那行
    expect(atFirstLine(text, 5)).toBe(false);
    expect(atLastLine(text, 5)).toBe(false);
    // 最後一行
    expect(atFirstLine(text, text.length)).toBe(false);
    expect(atLastLine(text, text.length)).toBe(true);
  });

  it('空字串兩邊都算', () => {
    expect(atFirstLine('', 0)).toBe(true);
    expect(atLastLine('', 0)).toBe(true);
  });
});
