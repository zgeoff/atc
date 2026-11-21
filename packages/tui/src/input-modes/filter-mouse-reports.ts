export interface MouseArea {
  readonly cols: number;
  readonly rows: number;
}

const ESC = '\u001B';

const SGR_REPORT = new RegExp(`${ESC}\\[<\\d+;(?<col>\\d+);(?<row>\\d+)[Mm]`, 'gu');
const URXVT_REPORT = new RegExp(`${ESC}\\[\\d+;(?<col>\\d+);(?<row>\\d+)M`, 'gu');

const DEFAULT_REPORT = new RegExp(
  `${ESC}\\[M[\\u0020-\\u00FF](?<col>[\\u0020-\\u00FF])(?<row>[\\u0020-\\u00FF])`,
  'gu',
);

// Drops each mouse report outside the PTY's area, in any of the three encodings. The user's
// terminal reports the whole window, but the session owns only the area its PTY has, and never the
// row the fleet bar keeps.
export function filterMouseReports(data: string, area: MouseArea): string {
  const isOutside = (col: number, row: number): boolean =>
    col < 1 || row < 1 || col > area.cols || row > area.rows;

  const dropDecimal = (match: string, ...rest: unknown[]): string => {
    const groups = readGroups(rest);

    return isOutside(Number(groups['col']), Number(groups['row'])) ? '' : match;
  };

  const dropByte = (match: string, ...rest: unknown[]): string => {
    const groups = readGroups(rest);
    const col = (groups['col']?.codePointAt(0) ?? 0) - 32;
    const row = (groups['row']?.codePointAt(0) ?? 0) - 32;

    return isOutside(col, row) ? '' : match;
  };

  return data
    .replaceAll(SGR_REPORT, dropDecimal)
    .replaceAll(URXVT_REPORT, dropDecimal)
    .replaceAll(DEFAULT_REPORT, dropByte);
}

// The last argument of a replace callback holds the named groups.
function readGroups(rest: readonly unknown[]): Record<string, string | undefined> {
  const groups = rest.at(-1);

  return typeof groups === 'object' && groups !== null ? { ...groups } : {};
}
