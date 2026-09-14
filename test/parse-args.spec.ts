import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/shared/parse-args';

describe('parseArgs', () => {
  it('空白分隔', () => {
    expect(parseArgs('/c echo hello')).toEqual(['/c', 'echo', 'hello']);
  });

  it('沒有參數時是空陣列', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   \t ')).toEqual([]);
  });

  it('雙引號裡的空白保留，引號本身不是內容', () => {
    expect(parseArgs('/c echo "a b" c')).toEqual(['/c', 'echo', 'a b', 'c']);
  });

  it('引號可以只包住參數的一部分', () => {
    expect(parseArgs('--path="C:/Program Files/x"')).toEqual(['--path=C:/Program Files/x']);
  });

  it('引號裡的 \\" 是一個雙引號', () => {
    expect(parseArgs('"say \\"hi\\" now"')).toEqual(['say "hi" now']);
  });

  it('"" 是一個空字串參數', () => {
    expect(parseArgs('a "" b')).toEqual(['a', '', 'b']);
  });

  it('引號沒有配對就當作到行尾為止', () => {
    expect(parseArgs('echo "a b')).toEqual(['echo', 'a b']);
  });

  it('連續空白不會產生空參數', () => {
    expect(parseArgs('  a   b  ')).toEqual(['a', 'b']);
  });
});
