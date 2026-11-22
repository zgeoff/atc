import { match } from 'ts-pattern';
import type { RGB } from '../compositor/types';
import { SPINNER_FRAMES } from '../fleet-bar/constants';
import { pickPlaceColour } from '../places/pick-place-colour';
import { measureWidth } from '../terminal/measure-width';
import { formatDir } from '../terminal/pick-matches';
import { splitGraphemes } from '../terminal/split-graphemes';
import { AMBER, BLUE, CONTENT_COL, DONE, FAINT, MUTED, RUNNING, TEXT } from './constants';
import { fitText } from './fit-text';
import { formatAge } from './format-age';
import { COLUMN_GAP } from './plan-list-columns';
import type { ColumnPlan } from './plan-list-columns';
import { span } from './span';
import { toRGB } from './to-rgb';
import type { OverlaySessionView, PanelInput, PanelLine, PanelSpan, SessionRow } from './types';

export interface SessionLineContext {
  readonly input: Readonly<PanelInput>;
  readonly plan: ColumnPlan;
  readonly width: number;
  readonly isSelected: boolean;

  // true when jump mode runs and the row does not match the typed letters
  readonly isFaded: boolean;

  // the jump label of the row, when jump mode shows one
  readonly label: string | null;

  // every session row, which tells a sub-session from a session
  readonly all: readonly SessionRow[];
}

interface NameStyle {
  readonly fg: RGB;
  readonly bold: boolean;
}

// The line of one session: its bar, state glyph and name, then each column the plan keeps, the
// message and the age.
export function buildSessionLine(row: SessionRow, context: SessionLineContext): PanelLine {
  const session = row.session;
  const plan = context.plan;
  const input = context.input;
  const isDead = !session.alive || session.state === 'exited';
  const isNeedy = session.state === 'needs_you';

  const style: NameStyle = {
    fg: pickNameColour(isNeedy, isDead),
    bold: context.isSelected || isNeedy || (session.unread && !isDead),
  };

  const placeColour = toRGB(pickPlaceColour(session.place.key));
  const barGlyph = context.isSelected ? '▌' : '▎';
  const glyph = pickGlyph(session, input.spinnerFrame);

  const spans: PanelSpan[] = [
    span(CONTENT_COL, barGlyph, placeColour),
    span(CONTENT_COL + 1, glyph.text, glyph.fg),
  ];

  let col = CONTENT_COL + 3;
  const name = fitText(formatName(session, context.all), plan.name, true);

  spans.push(
    ...buildNameSpans(name, col, style, { typed: input.jump?.typed ?? '', label: context.label }),
  );

  col += plan.name + COLUMN_GAP;

  if (plan.daemon > 0) {
    const daemon = fitText(session.daemon ?? 'local', plan.daemon, true);

    spans.push(span(col, daemon, MUTED));

    col += plan.daemon + COLUMN_GAP;
  }

  if (plan.place > 0) {
    const isPlaceMode = input.grouping === 'place';
    const text = isPlaceMode ? formatVia(row) : session.place.label;
    const colour = isPlaceMode ? MUTED : placeColour;

    spans.push(span(col, fitText(text, plan.place, true), colour));

    col += plan.place + COLUMN_GAP;
  }

  if (plan.repo > 0) {
    const repo = fitText(formatDir(session.repoRoot), plan.repo, true);

    spans.push(span(col, repo, MUTED));

    col += plan.repo + COLUMN_GAP;
  }

  if (plan.agent > 0) {
    const agent = fitText(input.readAgentLabel(session), plan.agent, true);

    spans.push(span(col, agent, MUTED));

    col += plan.agent + COLUMN_GAP;
  }

  const message = fitText(formatMessage(session), plan.message);

  spans.push(span(col, message, pickMessageColour(isNeedy, isDead)));

  const age = formatAge(session.state, session.stateSince, input.nowMs);

  if (age !== '' && plan.age > 0) {
    spans.push(span(context.width - CONTENT_COL - age.length, age, MUTED));
  }

  return { spans, isSelected: context.isSelected, isFaded: context.isFaded };
}

function pickNameColour(isNeedy: boolean, isDead: boolean): RGB {
  if (isNeedy) {
    return AMBER;
  }

  return isDead ? MUTED : TEXT;
}

function pickGlyph(
  session: Readonly<OverlaySessionView>,
  spinnerFrame: number,
): { readonly text: string; readonly fg: RGB } {
  return match(session.state)
    .returnType<{ readonly text: string; readonly fg: RGB }>()
    .with('needs_you', () => ({ text: '◆', fg: AMBER }))
    .with('running', () => ({
      text: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? '⠋',
      fg: RUNNING,
    }))
    .with('done', () => ({ text: '✓', fg: DONE }))
    .with('exited', () => ({ text: '○', fg: MUTED }))
    .with('unknown', () => ({ text: '?', fg: MUTED }))
    .exhaustive();
}

interface NameJump {
  readonly typed: string;
  readonly label: string | null;
}

// The name, with the letters that jump mode matched in blue. The label, when the row has one, takes
// the place of the letters right after the match, or of the padding when the match ends the name.
function buildNameSpans(name: string, col: number, style: NameStyle, jump: NameJump): PanelSpan[] {
  const typed = jump.typed;
  const label = jump.label;
  const range = typed === '' ? null : findMatchedGraphemes(name, typed.toLowerCase());

  if (range === null) {
    return [{ col, text: name, fg: style.fg, bold: style.bold }];
  }

  const graphemes = splitGraphemes(name).map((grapheme) => grapheme.text);
  const before = graphemes.slice(0, range.start).join('');
  const matched = graphemes.slice(range.start, range.end).join('');
  const labelLength = label?.length ?? 0;
  const replaced = graphemes.slice(range.end, range.end + labelLength).join('');
  const after = graphemes.slice(range.end + labelLength).join('');
  const matchedCol = col + measureWidth(before);
  const labelCol = matchedCol + measureWidth(matched);

  const spans: PanelSpan[] = [
    { col, text: before, fg: style.fg, bold: style.bold },
    { col: matchedCol, text: matched, fg: BLUE, bold: true },
  ];

  if (label !== null) {
    const padding = ' '.repeat(Math.max(0, measureWidth(replaced) - label.length));

    spans.push({ col: labelCol, text: `${label}${padding}`, fg: AMBER, bold: true });
  }

  spans.push({
    col: labelCol + Math.max(measureWidth(replaced), labelLength),
    text: after,
    fg: style.fg,
    bold: style.bold,
  });

  return spans;
}

// The graphemes, from `start` up to but not including `end`, whose lowercase holds the first match
// of `needle`. A letter's lowercase can be longer than the letter, as `İ` is.
function findMatchedGraphemes(
  name: string,
  needle: string,
): { readonly start: number; readonly end: number } | null {
  const lowered = splitGraphemes(name).map((grapheme) => grapheme.text.toLowerCase());
  const at = lowered.join('').indexOf(needle);

  if (at === -1) {
    return null;
  }

  let offset = 0;
  let start = -1;

  for (const [index, text] of lowered.entries()) {
    const next = offset + text.length;

    if (start === -1 && at < next) {
      start = index;
    }

    if (at + needle.length <= next) {
      return { start, end: index + 1 };
    }

    offset = next;
  }

  return null;
}

export function formatName(
  session: Readonly<OverlaySessionView>,
  all: readonly SessionRow[],
): string {
  const isSub =
    session.parent !== null &&
    all.some((row) => row.session.id === session.parent && row.session.daemon === session.daemon);

  return isSub ? `↳ ${session.name}` : session.name;
}

export function formatVia(row: SessionRow): string {
  return row.via === null ? '' : `via ${row.via}`;
}

function formatMessage(session: Readonly<OverlaySessionView>): string {
  if (session.hostAsleep) {
    return 'asleep';
  }

  if (session.harness === 'suspended') {
    return 'suspended';
  }

  if (session.state === 'needs_you') {
    return session.lastMsg === '' ? 'needs you' : `needs you: ${session.lastMsg}`;
  }

  return session.lastMsg;
}

function pickMessageColour(isNeedy: boolean, isDead: boolean): RGB {
  if (isNeedy) {
    return AMBER;
  }

  return isDead ? FAINT : TEXT;
}
