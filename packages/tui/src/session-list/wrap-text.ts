import { measureWidth } from '../terminal/measure-width';
import { fitText } from './fit-text';

// The text broken at spaces into lines of at most `width` terminal columns. A word wider than
// `width` is cut with `…`.
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(' ').filter((part) => part !== '')) {
    const fitted = fitText(word, width);
    const joined = line === '' ? fitted : `${line} ${fitted}`;

    if (measureWidth(joined) <= width) {
      line = joined;
      continue;
    }

    lines.push(line);

    line = fitted;
  }

  lines.push(line);

  return lines;
}
