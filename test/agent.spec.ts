import { describe, it, expect } from 'vitest';
import { formatTokens } from '../src/shared/agent';

describe('formatTokens', () => {
  it('1000 以下照原樣寫', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(7)).toBe('7');
    expect(formatTokens(999)).toBe('999');
  });

  it('1000 以上縮成一位小數的 k', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(11943)).toBe('11.9k');
  });
});
