/**
 * Splits text into rows no wider than `width`, breaking at spaces. A word
 * wider than a row breaks at the row's edge.
 */
export function splitToWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const rows: string[] = [];
  let row = '';

  for (const word of text.split(' ')) {
    let rest = word;

    while (rest.length > width) {
      if (row !== '') {
        rows.push(row);

        row = '';
      }

      rows.push(rest.slice(0, width));

      rest = rest.slice(width);
    }

    if (row === '') {
      row = rest;
    } else if (row.length + 1 + rest.length <= width) {
      row = `${row} ${rest}`;
    } else {
      rows.push(row);

      row = rest;
    }
  }

  if (row !== '') {
    rows.push(row);
  }

  return rows;
}
