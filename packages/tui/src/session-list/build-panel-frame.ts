import { measureWidth } from '../terminal/measure-width';
import { KEY_BAR_GAP, buildKeyBar } from './build-key-bar';
import { AMBER, BLUE, BORDER_COLOUR, CONTENT_COL, MUTED, TEXT } from './constants';
import { fitText } from './fit-text';
import { pickLastLine } from './pick-last-line';
import type { LastLine } from './pick-last-line';
import { span } from './span';
import type { OverlaySessionView, PanelInput, PanelLine, PanelSpan, SessionRow } from './types';
import { wrapText } from './wrap-text';

export interface PanelFrameInput {
  readonly input: Readonly<PanelInput>;
  readonly sessions: readonly SessionRow[];
  readonly selected: Readonly<OverlaySessionView> | undefined;
  readonly width: number;

  // the session rows that the window leaves out above and below
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;

  // the lines of the panel's last line, from buildLastLines
  readonly lastLines: readonly PanelLine[];
}

export interface PanelFrame {
  readonly topBorder: PanelLine;
  readonly divider: PanelLine;
  readonly lastLines: readonly PanelLine[];
  readonly bottomBorder: PanelLine;
}

// The lines around the list: the top border with the title, the divider with the count of hidden
// rows, the last lines, and the bottom border.
export function buildPanelFrame(frame: Readonly<PanelFrameInput>): PanelFrame {
  const width = frame.width;

  return {
    topBorder: buildTopBorder(frame),
    divider: buildDivider(frame),
    lastLines: frame.lastLines,
    bottomBorder: { spans: buildRule(width, '╰', '╯'), isSelected: false },
  };
}

function buildTopBorder(frame: Readonly<PanelFrameInput>): PanelLine {
  const needYou = frame.sessions.filter((row) => row.session.state === 'needs_you').length;
  const count = String(frame.sessions.length);
  const noun = frame.sessions.length === 1 ? ' session' : ' sessions';
  const tail = `${noun}${formatGrouping(frame.input.grouping)}`;

  const title: Omit<PanelSpan, 'col'>[] = [
    { text: ' ', fg: TEXT, bold: false },
    { text: count, fg: TEXT, bold: true },
    { text: tail, fg: MUTED, bold: false },
    ...(needYou > 0
      ? [
          { text: ' ·', fg: MUTED, bold: false },
          { text: ` ◆ ${needYou} need you`, fg: AMBER, bold: false },
        ]
      : []),
  ];

  // the title ends with a space, and one rule character stays before the corner
  const fitted = fitSpans(title, 2, frame.width - 3);
  const last = fitted.at(-1);
  const end = last === undefined ? 2 : last.col + measureWidth(last.text);

  return {
    spans: [...buildRule(frame.width, '╭', '╮'), ...fitted, span(end, ' ', TEXT)],
    isSelected: false,
  };
}

function formatGrouping(grouping: PanelInput['grouping']): string {
  if (grouping === 'flat') {
    return '';
  }

  return grouping === 'repo' ? ' · by repo' : ' · by place';
}

// The texts laid one after the other from `startCol`, cut with `…` where they would reach
// `endCol`, and left out past it.
function fitSpans(
  texts: readonly Omit<PanelSpan, 'col'>[],
  startCol: number,
  endCol: number,
): PanelSpan[] {
  const spans: PanelSpan[] = [];
  let col = startCol;

  for (const text of texts) {
    const room = endCol - col;
    const fitted = fitText(text.text, room);

    if (fitted === '') {
      break;
    }

    spans.push({ ...text, col, text: fitted });

    col += measureWidth(fitted);

    if (fitted !== text.text) {
      break;
    }
  }

  return spans;
}

function buildRule(width: number, left: string, right: string): PanelSpan[] {
  return [
    span(0, left, BORDER_COLOUR),
    span(1, '─'.repeat(Math.max(0, width - 2)), BORDER_COLOUR),
    span(width - 1, right, BORDER_COLOUR),
  ];
}

function buildDivider(frame: Readonly<PanelFrameInput>): PanelLine {
  const spans = buildRule(frame.width, '├', '┤');

  const counts = [
    ...(frame.hiddenAbove > 0 ? [`↑ ${frame.hiddenAbove}`] : []),
    ...(frame.hiddenBelow > 0 ? [`↓ ${frame.hiddenBelow}`] : []),
  ];

  // the long form, then the counts alone, whichever leaves two rule characters by each corner
  const text = [
    ` ${counts.map((count) => `${count} more`).join('  ')} `,
    ` ${counts.join('  ')} `,
  ].find((candidate) => measureWidth(candidate) <= frame.width - 6);

  if (counts.length > 0 && text !== undefined) {
    spans.push(span(frame.width - 3 - measureWidth(text), text, MUTED));
  }

  return { spans, isSelected: false };
}

// The panel's last lines. A prompt wraps over as many lines as it needs, so the action, what it
// deletes and the keys that confirm it always show. Every other text takes one line.
export function buildLastLines(
  input: Readonly<PanelInput>,
  frame: Pick<PanelFrameInput, 'sessions' | 'selected' | 'width'>,
): PanelLine[] {
  const room = frame.width - CONTENT_COL * 2;

  const last = pickLastLine({
    prompt: input.prompt,
    filter: input.filter,
    isJumpEmpty:
      input.jump !== null && input.jump.typed !== '' && !input.jump.matches.includes(true),
    notice: input.notice,
    daemonLine: input.daemonLine,
    updateAdvice: input.updateAdvice,
  });

  if (last.kind === 'prompt') {
    return wrapText(last.text, room).map((text) => ({
      spans: [...buildEdges(frame.width), span(CONTENT_COL, text, AMBER)],
      isSelected: false,
    }));
  }

  return [buildLastLine(last, frame, room)];
}

export function buildEdges(width: number): PanelSpan[] {
  return [span(0, '│', BORDER_COLOUR), span(width - 1, '│', BORDER_COLOUR)];
}

function buildLastLine(
  last: Exclude<LastLine, { readonly kind: 'prompt' }>,
  frame: Pick<PanelFrameInput, 'selected' | 'width'>,
  room: number,
): PanelLine {
  const edges = buildEdges(frame.width);

  if (last.kind === 'filter') {
    const text = fitText(last.text, room - 3);
    const cursorCol = CONTENT_COL + 2 + measureWidth(text);

    return {
      spans: [
        ...edges,
        span(CONTENT_COL, '/', BLUE),
        span(CONTENT_COL + 2, text, TEXT),
        span(cursorCol, '█', AMBER),
      ],
      isSelected: false,
    };
  }

  if (last.kind === 'text') {
    return {
      spans: [...edges, span(CONTENT_COL, fitText(last.text, room), TEXT)],
      isSelected: false,
    };
  }

  return { spans: [...edges, ...buildKeySpans(frame.selected, room)], isSelected: false };
}

function buildKeySpans(
  selected: Readonly<OverlaySessionView> | undefined,
  room: number,
): PanelSpan[] {
  const spans: PanelSpan[] = [];
  let col = CONTENT_COL;

  for (const item of buildKeyBar(selected, room)) {
    const keyWidth = measureWidth(item.key);

    spans.push(
      { col, text: item.key, fg: BLUE, bold: true },
      span(col + keyWidth + 1, item.label, MUTED),
    );

    col += keyWidth + 1 + measureWidth(item.label) + KEY_BAR_GAP;
  }

  return spans;
}
