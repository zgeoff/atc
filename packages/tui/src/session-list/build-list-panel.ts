import { pickPlaceColour } from '../places/pick-place-colour';
import { measureWidth } from '../terminal/measure-width';
import { formatDir } from '../terminal/pick-matches';
import { buildEdges, buildLastLines, buildPanelFrame } from './build-panel-frame';
import { buildSessionLine, formatName, formatVia } from './build-session-line';
import {
  AMBER,
  BORDER_COLOUR,
  CONTENT_COL,
  MAX_PANEL_WIDTH,
  MUTED,
  PANEL_MARGIN_COLS,
  PANEL_MARGIN_ROWS,
  TEXT,
  WIDE_PANEL_COLS,
} from './constants';
import { findNextAgeChangeAt } from './find-next-age-change-at';
import { fitText } from './fit-text';
import { planListColumns } from './plan-list-columns';
import type { ColumnPlan } from './plan-list-columns';
import { planListWindow } from './plan-list-window';
import { span } from './span';
import { toRGB } from './to-rgb';
import type { ListRow, PanelInput, PanelLine, PanelPlan, PanelSpan, SessionRow } from './types';

const MIN_PANEL_WIDTH = 24;

interface Size {
  readonly cols: number;
  readonly rows: number;
}

// Lays the panel out for a terminal of `size`: where it sits and, for each of its lines, the
// spans of text with their columns and colours.
export function buildListPanel(input: Readonly<PanelInput>, size: Size): PanelPlan {
  const width = Math.min(
    size.cols,
    Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, size.cols - PANEL_MARGIN_COLS)),
  );

  const sessions = input.rows.flatMap((row) => (row.kind === 'session' ? [row] : []));
  const plan = planColumns(input, sessions, width);
  const content = buildContentLines(input, sessions, plan, width);
  const selected = sessions[input.selected]?.session;

  const budget = planLineBudget(
    buildLastLines(input, { sessions, selected, width }),
    size.rows - PANEL_MARGIN_ROWS,
    size.rows - 1,
  );

  const window = planListWindow(content.lines.length, budget.capacity, content.selectedLine);

  const shown = content.lines.slice(window.start, window.end).map((line) => ({
    spans: [...buildEdges(width), ...line.spans],
    isSelected: line.isSelected,
  }));

  const height = shown.length + budget.borders + budget.lastLines.length;

  const frame = buildPanelFrame({
    input,
    sessions,
    selected,
    width,
    lastLines: budget.lastLines,
    hiddenAbove: countSessionLines(content.lineSessions.slice(0, window.start)),
    hiddenBelow: countSessionLines(content.lineSessions.slice(window.end)),
  });

  return {
    left: Math.floor((size.cols - width) / 2),
    top: Math.max(0, Math.floor((size.rows - 1 - height) / 2)),
    width,
    isSpinning: sessions.some((row) => row.session.state === 'running'),
    nextAgeChangeAtMs:
      plan.age > 0
        ? findEarliestAgeChange(content.lineSessions.slice(window.start, window.end), input.nowMs)
        : null,
    content: shown,
    topBorder: budget.borders >= 1 ? frame.topBorder : null,
    divider: budget.borders >= 3 ? frame.divider : null,
    lastLines: frame.lastLines,
    bottomBorder: budget.borders >= 2 ? frame.bottomBorder : null,
  };
}

function planColumns(
  input: Readonly<PanelInput>,
  sessions: readonly SessionRow[],
  width: number,
): ColumnPlan {
  const isPlaceMode = input.grouping === 'place';

  const widest = (read: (row: SessionRow) => string): number =>
    Math.max(0, ...sessions.map((row) => measureWidth(read(row))));

  return planListColumns({
    contentWidth: width - CONTENT_COL * 2,
    isNarrow: width < WIDE_PANEL_COLS,
    showDaemon: input.showDaemon && !isPlaceMode,
    showRepo: input.grouping !== 'repo',
    wants: {
      name: widest((row) => formatName(row.session, sessions)),
      daemon: widest((row) => row.session.daemon ?? 'local'),
      place: widest((row) => (isPlaceMode ? formatVia(row) : row.session.place.label)),
      repo: widest((row) => formatDir(row.session.repoRoot)),
      agent: widest((row) => input.readAgentLabel(row.session)),
    },
  });
}

interface ContentLines {
  readonly lines: readonly PanelLine[];

  // for each line, the session row it holds, or null
  readonly lineSessions: readonly (SessionRow | null)[];
  readonly selectedLine: number;
}

function buildContentLines(
  input: Readonly<PanelInput>,
  sessions: readonly SessionRow[],
  plan: ColumnPlan,
  width: number,
): ContentLines {
  if (sessions.length === 0) {
    const isSearching = input.filter !== null || input.jump !== null;
    const text = isSearching ? 'no matches' : 'no sessions — n to spawn';

    return {
      lines: [{ spans: [span(CONTENT_COL, text, MUTED)], isSelected: false }],
      lineSessions: [null],
      selectedLine: 0,
    };
  }

  const lines: PanelLine[] = [];
  const lineSessions: (SessionRow | null)[] = [];
  let sessionIndex = 0;
  let selectedLine = 0;

  for (const [rowIndex, row] of input.rows.entries()) {
    if (row.kind === 'header') {
      if (lines.length > 0) {
        lines.push({ spans: [], isSelected: false });
        lineSessions.push(null);
      }

      lines.push(buildHeaderLine(row, input.rows[rowIndex + 1], width));
      lineSessions.push(null);
      continue;
    }

    const isSelected = sessionIndex === input.selected;

    if (isSelected) {
      selectedLine = lines.length;
    }

    const label = input.jump?.labels[sessionIndex] ?? null;

    lines.push(buildSessionLine(row, { input, plan, width, isSelected, label, all: sessions }));
    lineSessions.push(row);

    sessionIndex += 1;
  }

  return { lines, lineSessions, selectedLine };
}

function buildHeaderLine(
  row: Extract<ListRow, { readonly kind: 'header' }>,
  next: ListRow | undefined,
  width: number,
): PanelLine {
  const colour = pickHeaderColour(row, next);
  const count = String(row.count);
  const need = row.needYou > 0 ? `◆ ${row.needYou}` : '';
  const ruleEnd = width - CONTENT_COL;
  const marksWidth = 2 + count.length + (need === '' ? 0 : 2 + measureWidth(need));
  const label = fitText(row.label, ruleEnd - CONTENT_COL - marksWidth);
  const spans: PanelSpan[] = [{ col: CONTENT_COL, text: label, fg: colour, bold: true }];
  let col = CONTENT_COL + measureWidth(label) + 2;

  spans.push(span(col, count, MUTED));

  col += count.length;

  if (need !== '') {
    spans.push(span(col + 2, need, AMBER));

    col += 2 + measureWidth(need);
  }

  if (col + 1 < ruleEnd) {
    spans.push(span(col + 1, '─'.repeat(ruleEnd - col - 1), BORDER_COLOUR));
  }

  return { spans, isSelected: false };
}

// A header takes the colour of its group's first place, so a place group matches its rows' bars.
function pickHeaderColour(
  row: Extract<ListRow, { readonly kind: 'header' }>,
  next: ListRow | undefined,
) {
  if (next?.kind !== 'session' || row.label === 'pinned') {
    return TEXT;
  }

  return toRGB(pickPlaceColour(next.session.place.key));
}

interface LineBudget {
  readonly lastLines: readonly PanelLine[];

  // how many of the top border, the bottom border and the divider show, in that order
  readonly borders: number;
  readonly capacity: number;
}

// the lines of the panel's frame besides its last lines: the top border, the divider and the
// bottom border
const FRAME_LINES = 3;

// How the panel's lines share the rows above the fleet bar. Short of rows, the last lines win over
// the list, then the divider, the bottom border and the top border, in that order. A prompt longer
// than every row keeps its end, which holds the keys that confirm it.
function planLineBudget(
  lastLines: readonly PanelLine[],
  preferredRows: number,
  availableRows: number,
): LineBudget {
  const kept = lastLines.slice(Math.max(0, lastLines.length - Math.max(0, availableRows)));
  const frameRoom = Math.max(0, availableRows - kept.length);
  const borders = Math.min(FRAME_LINES, frameRoom);
  const preferred = Math.max(1, preferredRows - FRAME_LINES - kept.length);

  return { lastLines: kept, borders, capacity: Math.min(preferred, frameRoom - borders) };
}

function countSessionLines(lineSessions: readonly (SessionRow | null)[]): number {
  return lineSessions.filter((row) => row !== null).length;
}

// the first moment an age on the shown rows changes, or null when no shown row has an age
function findEarliestAgeChange(
  lineSessions: readonly (SessionRow | null)[],
  nowMs: number,
): number | null {
  const changes = lineSessions.flatMap((row) => {
    const at =
      row === null ? null : findNextAgeChangeAt(row.session.state, row.session.stateSince, nowMs);

    return at === null ? [] : [at];
  });

  return changes.length === 0 ? null : Math.min(...changes);
}
