/**
 * 把「參數」那一欄拆成參數陣列。
 * 用空白分隔，但雙引號裡的空白會保留（引號本身不是內容），引號裡的 \" 是一個雙引號。
 * 引號沒有配對就當作到行尾為止 —— 使用者還在打字時不要把東西吃掉。
 *
 * 只有這一種規則：不展開變數、不處理單引號，跟 Windows 的命令列引號規則一樣只認雙引號。
 */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  // 有沒有正在組一個參數；"" 是一個空字串參數，跟「什麼都沒有」不一樣。
  let started = false;
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted && char === '\\' && text[i + 1] === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }

    if (!quoted && /\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) args.push(current);
  return args;
}
