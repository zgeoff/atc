import { match } from 'ts-pattern';
import type { RGB } from '../compositor/types';
import { SPINNER_FRAMES } from '../fleet-bar/constants';
import { pickPlaceColour } from '../places/pick-place-colour';
import { measureWidth } from '../terminal/measure-width';
import { formatDir } from '../terminal/pick-matches';
import { AMBER, CONTENT_COL, DONE, FAINT, MUTED, RUNNING, TEXT } from './constants';
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

  // the jump label of the row, when jump mode runs
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

  const spans: PanelSpan[] = [
    span(CONTENT_COL, barGlyph, placeColour),
    ...buildMarkSpans(session, context),
  ];

  let col = CONTENT_COL + 3;
  const name = fitText(formatName(session, context.all), plan.name, true);

  spans.push(...buildNameSpans(name, col, style, input.jump?.typed ?? ''));

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

  if (age !== '') {
    spans.push(span(context.width - CONTENT_COL - age.length, age, MUTED));
  }

  return { spans, isSelected: context.isSelected };
}

function pickNameColour(isNeedy: boolean, isDead: boolean): RGB {
  if (isNeedy) {
    return AMBER;
  }

  return isDead ? MUTED : TEXT;
}

function buildMarkSpans(
  session: Readonly<OverlaySessionView>,
  context: SessionLineContext,
): PanelSpan[] {
  if (context.label !== null) {
    return [{ col: CONTENT_COL + 1, text: context.label, fg: AMBER, bold: true }];
  }

  const glyph = pickGlyph(session, context.input.spinnerFrame);

  return [span(CONTENT_COL + 1, glyph.text, glyph.fg)];
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

// The name, with the letters that jump mode matched in amber.
function buildNameSpans(name: string, col: number, style: NameStyle, typed: string): PanelSpan[] {
  const at = typed === '' ? -1 : name.toLowerCase().indexOf(typed.toLowerCase());

  if (at === -1) {
    return [{ col, text: name, fg: style.fg, bold: style.bold }];
  }

  const before = name.slice(0, at);
  const matched = name.slice(at, at + typed.length);
  const after = name.slice(at + typed.length);

  return [
    { col, text: before, fg: style.fg, bold: style.bold },
    { col: col + measureWidth(before), text: matched, fg: AMBER, bold: true },
    { col: col + measureWidth(before + matched), text: after, fg: style.fg, bold: style.bold },
  ];
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
