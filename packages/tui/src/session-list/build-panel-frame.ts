import { measureWidth } from '../terminal/measure-width';
import { KEY_BAR_GAP, buildKeyBar } from './build-key-bar';
import { AMBER, BLUE, BORDER_COLOUR, CONTENT_COL, MUTED, TEXT } from './constants';
import { fitText } from './fit-text';
import { pickLastLine } from './pick-last-line';
import { span } from './span';
import type { OverlaySessionView, PanelInput, PanelLine, PanelSpan, SessionRow } from './types';

export interface PanelFrameInput {
  readonly input: Readonly<PanelInput>;
  readonly sessions: readonly SessionRow[];
  readonly selected: Readonly<OverlaySessionView> | undefined;
  readonly width: number;

  // the session rows that the window leaves out above and below
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export interface PanelFrame {
  readonly topBorder: PanelLine;
  readonly divider: PanelLine;
  readonly lastLine: PanelLine;
  readonly bottomBorder: PanelLine;
}

// The four lines around the list: the top border with the title, the divider with the count of
// hidden rows, the last line, and the bottom border.
export function buildPanelFrame(frame: Readonly<PanelFrameInput>): PanelFrame {
  const width = frame.width;

  return {
    topBorder: buildTopBorder(frame),
    divider: buildDivider(frame),
    lastLine: buildLastLine(frame),
    bottomBorder: { spans: buildRule(width, '╰', '╯'), isSelected: false },
  };
}

function buildTopBorder(frame: Readonly<PanelFrameInput>): PanelLine {
  const needYou = frame.sessions.filter((row) => row.session.state === 'needs_you').length;
  const count = String(frame.sessions.length);
  const noun = frame.sessions.length === 1 ? ' session' : ' sessions';
  const tail = `${noun}${formatGrouping(frame.input.grouping)}`;

  const spans: PanelSpan[] = [
    ...buildRule(frame.width, '╭', '╮'),
    span(2, ' ', TEXT),
    { col: 3, text: count, fg: TEXT, bold: true },
    span(3 + count.length, tail, MUTED),
  ];

  let col = 3 + count.length + measureWidth(tail);

  if (needYou > 0) {
    const need = ` ◆ ${needYou} need you`;

    spans.push(span(col, ' ·', MUTED), span(col + 2, need, AMBER));

    col += 2 + measureWidth(need);
  }

  spans.push(span(col, ' ', TEXT));

  return { spans, isSelected: false };
}

function formatGrouping(grouping: PanelInput['grouping']): string {
  if (grouping === 'flat') {
    return '';
  }

  return grouping === 'repo' ? ' · by repo' : ' · by place';
}

function buildRule(width: number, left: string, right: string): PanelSpan[] {
  return [
    span(0, left, BORDER_COLOUR),
    span(1, '─'.repeat(width - 2), BORDER_COLOUR),
    span(width - 1, right, BORDER_COLOUR),
  ];
}

function buildDivider(frame: Readonly<PanelFrameInput>): PanelLine {
  const spans = buildRule(frame.width, '├', '┤');

  const parts = [
    ...(frame.hiddenAbove > 0 ? [`↑ ${frame.hiddenAbove} more`] : []),
    ...(frame.hiddenBelow > 0 ? [`↓ ${frame.hiddenBelow} more`] : []),
  ];

  if (parts.length > 0) {
    const text = ` ${parts.join('  ')} `;

    spans.push(span(frame.width - 3 - measureWidth(text), text, MUTED));
  }

  return { spans, isSelected: false };
}

function buildLastLine(frame: Readonly<PanelFrameInput>): PanelLine {
  const input = frame.input;
  const room = frame.width - CONTENT_COL * 2;
  const edges = [span(0, '│', BORDER_COLOUR), span(frame.width - 1, '│', BORDER_COLOUR)];

  const last = pickLastLine({
    prompt: input.prompt,
    filter: input.filter,
    isJumpEmpty: input.jump !== null && frame.sessions.length === 0,
    notice: input.notice,
    daemonLine: input.daemonLine,
    updateAdvice: input.updateAdvice,
  });

  if (last.kind === 'prompt') {
    return {
      spans: [...edges, span(CONTENT_COL, fitText(last.text, room), AMBER)],
      isSelected: false,
    };
  }

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
