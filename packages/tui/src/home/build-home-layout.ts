import { measureWidth } from '../terminal/measure-width';
import { truncate } from '../terminal/truncate';
import type { HomeInput, HomeLayout, HomeRun, Wordmark } from './types';

interface WindowSize {
  readonly cols: number;
  readonly rows: number;
}

// Lays out the stack: the wordmark, the fleet line, a blank row and the keys, centred in the window.
// The notices go below the stack, so a notice never moves it.
export function buildHomeLayout(
  window: WindowSize,
  wordmark: Wordmark,
  wordmarkSize: WindowSize,
  input: HomeInput,
): HomeLayout {
  const wordmarkGap = wordmark.kind === 'outline' ? 2 : 1;
  const keys = listKeys(input);
  const stackRows = wordmarkSize.rows + wordmarkGap + 1 + 1 + keys.length;
  const top = Math.max(0, Math.floor((window.rows - stackRows) / 2));
  const wordmarkAt = { col: centre(window.cols, wordmarkSize.cols), row: top };
  const fleetRow = top + wordmarkSize.rows + wordmarkGap;
  const keysRow = fleetRow + 2;

  const runs: HomeRun[] = [
    ...buildWordmarkRuns(window, wordmark, wordmarkAt.row),
    ...buildFleetRuns(window.cols, fleetRow, input),
    ...buildKeyRuns(window.cols, keysRow, keys),
    ...buildNoticeRuns(window.cols, keysRow + keys.length + 1, input.notices),
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

function buildFleetRuns(cols: number, row: number, input: HomeInput): HomeRun[] {
  const count = String(input.sessionCount);

  const parts: Pick<HomeRun, 'text' | 'tone' | 'bold' | 'dim'>[] =
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

  if (input.needYouCount > 0) {
    parts.push(
      { text: FLEET_SEPARATOR, tone: 'plain', bold: false, dim: true },
      { text: '◆ ', tone: 'amber', bold: false, dim: false },
      {
        text: String(input.needYouCount),
        tone: 'amber',
        bold: true,
        dim: false,
      },
      { text: ' need you', tone: 'amber', bold: false, dim: true },
    );
  }

  let col = centre(
    cols,
    parts.reduce((total, part) => total + measureWidth(part.text), 0),
  );

  const runs: HomeRun[] = [];

  for (const part of parts) {
    runs.push({ ...part, col, row });

    col += measureWidth(part.text);
  }

  return runs;
}

const KEY_GAP = 2;

function buildKeyRuns(cols: number, row: number, keys: readonly KeyEntry[]): HomeRun[] {
  const keyWidth = Math.max(...keys.map((entry) => measureWidth(entry.key)));
  const labelWidth = Math.max(...keys.map((entry) => measureWidth(entry.label)));
  const left = centre(cols, keyWidth + KEY_GAP + labelWidth);

  return keys.flatMap((entry, index) => [
    {
      col: left + keyWidth - measureWidth(entry.key),
      row: row + index,
      text: entry.key,
      tone: 'blue' as const,
      bold: true,
      dim: false,
    },
    {
      col: left + keyWidth + KEY_GAP,
      row: row + index,
      text: entry.label,
      tone: 'plain' as const,
      bold: false,
      dim: true,
    },
  ]);
}

function buildNoticeRuns(cols: number, row: number, notices: readonly string[]): HomeRun[] {
  if (notices.length === 0) {
    return [];
  }

  const text = truncate(notices.join(FLEET_SEPARATOR), cols);

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
