/**
 * Splits text into rows of at most `width` characters, breaking at spaces
 * and counting a grapheme cluster as one character. A word wider than a
 * row breaks at the row's edge, never inside a character.
 */
export function splitToWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const segmenter = new Intl.Segmenter();

  const rows: string[] = [];
  let row: string[] = [];

  for (const word of text.split(' ')) {
    let rest = Array.from(segmenter.segment(word), (part) => part.segment);

    while (rest.length > width) {
      if (row.length > 0) {
        rows.push(row.join(''));

        row = [];
      }

      rows.push(rest.slice(0, width).join(''));

      rest = rest.slice(width);
    }

    if (row.length === 0) {
      row = rest;
    } else if (row.length + 1 + rest.length <= width) {
      row = [...row, ' ', ...rest];
    } else {
      rows.push(row.join(''));

      row = rest;
    }
  }

  if (row.length > 0) {
    rows.push(row.join(''));
  }

  return rows;
}
