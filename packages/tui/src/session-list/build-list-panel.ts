import { pickPlaceColour } from '../places/pick-place-colour';
import { measureWidth } from '../terminal/measure-width';
import { formatDir } from '../terminal/pick-matches';
import { buildPanelFrame } from './build-panel-frame';
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
import { planListColumns } from './plan-list-columns';
import type { ColumnPlan } from './plan-list-columns';
import { planListWindow } from './plan-list-window';
import { span } from './span';
import { toRGB } from './to-rgb';
import type { ListRow, PanelInput, PanelLine, PanelPlan, PanelSpan, SessionRow } from './types';

const MIN_PANEL_WIDTH = 24;

// the lines of the panel's frame: the top border, the divider, the last line and the bottom border
const FRAME_LINES = 4;

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
  const capacity = Math.max(1, size.rows - PANEL_MARGIN_ROWS - FRAME_LINES);
  const window = planListWindow(content.lines.length, capacity, content.selectedLine);
  const shown = content.lines.slice(window.start, window.end);
  const height = shown.length + FRAME_LINES;

  const frame = buildPanelFrame({
    input,
    sessions,
    selected: sessions[input.selected]?.session,
    width,
    hiddenAbove: countSessionLines(content.sessionLines.slice(0, window.start)),
    hiddenBelow: countSessionLines(content.sessionLines.slice(window.end)),
  });

  return {
    left: Math.floor((size.cols - width) / 2),
    top: Math.max(0, Math.floor((size.rows - 1 - height) / 2)),
    width,
    isSpinning: sessions.some((row) => row.session.state === 'running'),
    content: shown,
    ...frame,
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

  // for each line, whether it holds a session row
  readonly sessionLines: readonly boolean[];
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
      sessionLines: [false],
      selectedLine: 0,
    };
  }

  const lines: PanelLine[] = [];
  const sessionLines: boolean[] = [];
  let sessionIndex = 0;
  let selectedLine = 0;

  for (const [rowIndex, row] of input.rows.entries()) {
    if (row.kind === 'header') {
      if (lines.length > 0) {
        lines.push({ spans: [], isSelected: false });
        sessionLines.push(false);
      }

      lines.push(buildHeaderLine(row, input.rows[rowIndex + 1], width));
      sessionLines.push(false);
      continue;
    }

    const isSelected = sessionIndex === input.selected;

    if (isSelected) {
      selectedLine = lines.length;
    }

    const label = input.jump?.labels[sessionIndex] ?? null;

    lines.push(buildSessionLine(row, { input, plan, width, isSelected, label, all: sessions }));
    sessionLines.push(true);

    sessionIndex += 1;
  }

  return { lines, sessionLines, selectedLine };
}

function buildHeaderLine(
  row: Extract<ListRow, { readonly kind: 'header' }>,
  next: ListRow | undefined,
  width: number,
): PanelLine {
  const colour = pickHeaderColour(row, next);
  const spans: PanelSpan[] = [{ col: CONTENT_COL, text: row.label, fg: colour, bold: true }];
  let col = CONTENT_COL + measureWidth(row.label) + 2;

  spans.push(span(col, String(row.count), MUTED));

  col += String(row.count).length;

  if (row.needYou > 0) {
    const need = `◆ ${row.needYou}`;

    spans.push(span(col + 2, need, AMBER));

    col += 2 + measureWidth(need);
  }

  const ruleEnd = width - CONTENT_COL;

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

function countSessionLines(sessionLines: readonly boolean[]): number {
  return sessionLines.filter(Boolean).length;
}
