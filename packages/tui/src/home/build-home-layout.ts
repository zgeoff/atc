import { fitText } from '../session-list/fit-text';
import { measureWidth } from '../terminal/measure-width';
import type { HomeInput, HomeLayout, HomeRun, Wordmark } from './types';

interface WindowSize {
  readonly cols: number;
  readonly rows: number;
}

// Lays out the stack: the wordmark, the fleet line, a blank row and the keys, centred in the window.
// The notice line goes below the stack and never moves it: one blank row under the keys, directly
// under them when the window is short, and nowhere when no row is left.
export function buildHomeLayout(
  window: WindowSize,
  wordmark: Wordmark,
  wordmarkSize: WindowSize,
  input: HomeInput,
): HomeLayout {
  const keys = listKeys(input);
  const fullWordmarkGap = wordmark.kind === 'outline' ? 2 : 1;
  const bodyRows = wordmarkSize.rows + 1 + 1 + keys.length;
  const overflow = Math.max(0, bodyRows + fullWordmarkGap - window.rows);
  const wordmarkGap = Math.max(0, fullWordmarkGap - overflow);
  const stackRows = bodyRows + wordmarkGap;
  const top = Math.max(0, Math.floor((window.rows - stackRows) / 2));
  const wordmarkAt = { col: centre(window.cols, wordmarkSize.cols), row: top };
  const fleetRow = top + wordmarkSize.rows + wordmarkGap;
  const keysRow = fleetRow + 2;
  const belowKeys = keysRow + keys.length;
  const noticeRow = belowKeys + 1 < window.rows ? belowKeys + 1 : belowKeys;

  const runs: HomeRun[] = [
    ...buildWordmarkRuns(window, wordmark, wordmarkAt.row),
    ...buildFleetRuns(window.cols, fleetRow, input),
    ...buildKeyRuns(window.cols, keysRow, keys),
    ...(noticeRow < window.rows ? buildNoticeRuns(window.cols, noticeRow, input.notices) : []),
  ];

  return { wordmarkAt, runs };
}

interface KeyEntry {
  readonly key: string;
  readonly label: string;
}

function listKeys(input: HomeInput): KeyEntry[] {
  const keys = [
    { key: input.leaderLabel, label: 'sessions' },
    { key: 'n', label: 'new' },
  ];

  return input.restorableCount > 0 ? [...keys, { key: 'R', label: 'restore' }] : keys;
}

function centre(width: number, contentWidth: number): number {
  return Math.max(0, Math.floor((width - contentWidth) / 2));
}

function buildWordmarkRuns(window: WindowSize, wordmark: Wordmark, row: number): HomeRun[] {
  return wordmark.kind === 'text'
    ? [
        {
          col: centre(window.cols, 3),
          row,
          text: 'atc',
          tone: 'mark',
          bold: true,
          dim: false,
        },
      ]
    : [];
}

const FLEET_SEPARATOR = '  ·  ';

type RunPart = Pick<HomeRun, 'text' | 'tone' | 'bold' | 'dim'>;

// A fleet line too wide for the window drops its need-you part first, then cuts the count.
function buildFleetRuns(cols: number, row: number, input: HomeInput): HomeRun[] {
  const count = String(input.sessionCount);

  const countParts: RunPart[] =
    input.sessionCount === 0
      ? [{ text: 'no sessions', tone: 'plain', bold: false, dim: true }]
      : [
          { text: count, tone: 'plain', bold: true, dim: false },
          {
            text: input.sessionCount === 1 ? ' session' : ' sessions',
            tone: 'plain',
            bold: false,
            dim: true,
          },
        ];

  const fullParts: RunPart[] =
    input.needYouCount > 0
      ? [
          ...countParts,
          { text: FLEET_SEPARATOR, tone: 'plain', bold: false, dim: true },
          { text: '◆ ', tone: 'amber', bold: false, dim: false },
          {
            text: String(input.needYouCount),
            tone: 'amber',
            bold: true,
            dim: false,
          },
          { text: ' need you', tone: 'amber', bold: false, dim: true },
        ]
      : countParts;

  const shownParts = measureParts(fullParts) <= cols ? fullParts : countParts;
  const parts = fitParts(shownParts, cols);

  return layParts(parts, centre(cols, measureParts(parts)), row);
}

function measureParts(parts: readonly RunPart[]): number {
  return parts.reduce((total, part) => total + measureWidth(part.text), 0);
}

// The parts cut to `width` columns as one text: the part that is cut ends in `…`, and the parts
// after it are dropped.
function fitParts(parts: readonly RunPart[], width: number): RunPart[] {
  const fitted = fitText(parts.map((part) => part.text).join(''), width);
  let offset = 0;

  return parts.flatMap((part) => {
    const text = fitted.slice(offset, offset + part.text.length);

    offset += part.text.length;

    return text === '' ? [] : [{ ...part, text }];
  });
}

function layParts(parts: readonly RunPart[], startCol: number, row: number): HomeRun[] {
  let col = startCol;

  return parts.map((part) => {
    const run = { ...part, col, row };

    col += measureWidth(part.text);

    return run;
  });
}

const KEY_GAP = 2;

function buildKeyRuns(cols: number, row: number, keys: readonly KeyEntry[]): HomeRun[] {
  const keyWidth = Math.max(...keys.map((entry) => measureWidth(entry.key)));
  const labelWidth = Math.max(...keys.map((entry) => measureWidth(entry.label)));
  const left = centre(cols, keyWidth + KEY_GAP + labelWidth);

  return keys.flatMap((entry, index) => {
    const startCol = left + keyWidth - measureWidth(entry.key);

    const parts = fitParts(
      [
        { text: entry.key, tone: 'blue', bold: true, dim: false },
        { text: ' '.repeat(KEY_GAP), tone: 'plain', bold: false, dim: true },
        { text: entry.label, tone: 'plain', bold: false, dim: true },
      ],
      cols - startCol,
    );

    return layParts(parts, startCol, row + index).filter((run) => run.text.trim() !== '');
  });
}

function buildNoticeRuns(cols: number, row: number, notices: readonly string[]): HomeRun[] {
  if (notices.length === 0) {
    return [];
  }

  const text = fitText(notices.join(FLEET_SEPARATOR), cols);

  return [
    {
      col: centre(cols, measureWidth(text)),
      row,
      text,
      tone: 'amber',
      bold: false,
      dim: false,
    },
  ];
}
