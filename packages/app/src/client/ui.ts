import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import { PINNED_GROUP_KEY } from '@atc/protocol';
import type { SessionState } from '@atc/protocol';
import { formatDir } from './dirs';
import { pickPinTarget } from './pick-pin-target';
import { planOverlayColumns } from './plan-overlay-columns';
import type { OverlayColumnPlan } from './plan-overlay-columns';
import { planVacatedRows } from './plan-vacated-rows';
import type { BoxExtent } from './plan-vacated-rows';
import type { HarnessLifecycle } from './to-mirror-session';

// The slice of a session the drawing layer needs; satisfied by both the
// daemon's sessions and the wire descriptors a client mirrors.
interface SessionView {
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
}

const ESC = '\u001B';

const GLYPH: Record<SessionState, string> = {
  needs_you: `${ESC}[31m●${ESC}[0m`,
  running: `${ESC}[36m◐${ESC}[0m`,
  done: `${ESC}[32m✓${ESC}[0m`,
  exited: `${ESC}[90m✗${ESC}[0m`,
};

function out(text: string) {
  process.stdout.write(text);
}

function truncate(text: string, max: number): string {
  // oxlint-disable-next-line no-control-regex -- stripping ANSI/newline control bytes is the point
  const clean = text.replaceAll(/[\r\n\u001B]+/gu, ' ');

  if (max <= 0) {
    return '';
  }

  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function cols(): number {
  return process.stdout.columns || 80;
}

// borders included; an item row holds 4 columns fewer.
export function getPickerWidth(): number {
  return Math.min(cols() - 4, 90);
}

export function rows(): number {
  return process.stdout.rows || 24;
}

export interface StatusView {
  readonly counts: Readonly<Record<SessionState, number>>;
  readonly focusedName: string | null;
  readonly urgentName: string | null;
  readonly leaderLabel: string;
  readonly stale: boolean;
  readonly restarting: boolean;
  readonly waiting?: boolean;

  // The remote daemon from the config the client runs against, which the
  // bar shows beside the name so a remote fleet never passes for the local
  // one; absent or null for the local daemon.
  readonly daemonName?: string | null;
}

export function drawStatusBar(view: StatusView) {
  const counts = view.counts;
  const width = cols();

  const where =
    view.daemonName === undefined || view.daemonName === null ? '' : `@${view.daemonName}`;

  const left = ` atc${where} ▏${view.focusedName ?? 'no session'} `;
  const parts: string[] = [];

  if (counts.needs_you > 0) {
    const who = view.urgentName === null ? '' : `: ${view.urgentName}`;

    parts.push(`● ${counts.needs_you} need you${who}`);
  }

  if (counts.done > 0) {
    parts.push(`✓ ${counts.done} done`);
  }

  if (counts.running > 0) {
    parts.push(`◐ ${counts.running} running`);
  }

  if (counts.exited > 0) {
    parts.push(`✗ ${counts.exited}`);
  }

  if (view.waiting === true) {
    parts.push('⟳ waiting for daemon');
  } else if (view.restarting) {
    parts.push('⟳ restarting daemon');
  } else if (view.stale) {
    parts.push('⟳ update ready');
  }

  const joined = parts.join(' ▏');
  const right = ` ${joined === '' ? 'idle' : joined} ▏${view.leaderLabel} `;
  const pad = Math.max(1, width - left.length - right.length);
  const bg = counts.needs_you > 0 ? `${ESC}[1;97;41m` : `${ESC}[30;47m`;
  const text = truncate(left + ' '.repeat(pad) + right, width).padEnd(width);

  out(ansi.saveCursor + ansi.moveTo(rows(), 1) + bg + text + ansi.reset + ansi.restoreCursor);
}

// All box rows are built as {styled, plainWidth} pairs so centering and edge
// alignment never depend on ANSI-stripped length math at draw time.
interface Row {
  readonly styled: string;
  readonly width: number;
}

// The extent of the last box drawn, so the next draw can erase the rows a
// shrinking or shifting box leaves behind. Erasing an already-blank row is a
// no-op, so a stale extent after a full clear is harmless.
let lastBoxExtent: BoxExtent | null = null;

function drawBox(rowsList: readonly Row[], write: (chunk: string) => void) {
  const boxWidth = Math.max(...rowsList.map((row) => row.width));
  const top = Math.max(1, Math.floor((rows() - 1 - rowsList.length) / 2));
  const left = Math.max(1, Math.floor((cols() - boxWidth) / 2));
  const extent: BoxExtent = { top, height: rowsList.length };
  let buf = ansi.hideCursor;

  for (const row of planVacatedRows(lastBoxExtent, extent)) {
    buf += `${ansi.moveTo(row, 1)}${ESC}[2K`;
  }

  lastBoxExtent = extent;

  for (const [index, row] of rowsList.entries()) {
    buf += ansi.moveTo(top + index, left) + row.styled;
  }

  write(buf);
}

function boxTop(width: number, title: string): Row {
  const framedTitle = ` ${title} `;

  return {
    styled: `┌${framedTitle}${'─'.repeat(Math.max(0, width - 2 - framedTitle.length))}┐`,
    width,
  };
}

function boxDivider(width: number): Row {
  return { styled: `├${'─'.repeat(width - 2)}┤`, width };
}

function boxBottom(width: number): Row {
  return { styled: `└${'─'.repeat(width - 2)}┘`, width };
}

function boxRow(width: number, styledContent: string, contentPlainLen: number): Row {
  const pad = ' '.repeat(Math.max(0, width - 4 - contentPlainLen));

  return { styled: `│ ${styledContent}${pad} │`, width };
}

function dimRow(width: number, text: string): Row {
  const truncated = truncate(text, width - 4);

  return boxRow(width, `${ESC}[90m${truncated}${ESC}[0m`, truncated.length);
}

// Selection-dependent hints need the liveness facts of each row.
export interface OverlaySessionView extends SessionView {
  readonly id: string;
  readonly parent: string | null;
  readonly alive: boolean;
  readonly kind: 'pty' | 'headless';
  readonly resumable: boolean;
  readonly canEject: boolean;
  readonly agent: AgentID;
  readonly pinned: boolean;
  readonly repoRoot: string;
  readonly target: string;
  readonly model: string | null;

  // Where the session's harness stands, apart from the attention its state
  // carries: running, suspended inside a sleeping host, or exited.
  readonly harness: HarnessLifecycle;
}

export interface OverlayView {
  sessions: readonly OverlaySessionView[];

  // The readable name per agent id, and each agent's tier-alias map, from
  // the daemon's `agents.list` answer over the config.
  agentLabels: Readonly<Record<AgentID, string>>;
  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  // Whether more than one execution target is available to spawn on, which
  // is what brings the target column in.
  showTarget: boolean;
  selected: number;
  confirmKill: boolean;

  // A kill the daemon refused because forgetting the session destroys its
  // host waits on a second confirm.
  confirmDestroy: boolean;
  filter: string | null;
  stale: boolean;
  grouped: boolean;
}

// A daemon-supplied id or alias can name an inherited property, so map
// reads go through an own-property check instead of indexing blindly.
function findMapValue<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// A session's model as the row draws it: the daemon answer's alias target,
// or the raw model string when the answer maps nothing for it.
function resolveModelAlias(
  models: Readonly<Record<AgentID, Readonly<Record<string, string>>>>,
  agent: AgentID,
  model: string,
): string {
  const aliases = findMapValue(models, agent);

  return aliases === undefined ? model : (findMapValue(aliases, model) ?? model);
}

// A session row draws status (the attention glyph plus the unread mark),
// pin, name, the flat view's directory, then the target, harness, model,
// harness lifecycle, and last event columns the width plan allows.
export function buildSessionRow(
  session: Readonly<OverlaySessionView>,
  plan: Readonly<OverlayColumnPlan>,
  view: Readonly<OverlayView>,
  sel: boolean,
): Row {
  const sub = session.parent !== null && view.sessions.some((x) => x.id === session.parent);

  const name =
    plan.nameWidth >= 4 && sub
      ? `↳ ${truncate(session.name, plan.nameWidth - 2)}`.padEnd(plan.nameWidth)
      : truncate(session.name, plan.nameWidth).padEnd(plan.nameWidth);

  const directory =
    plan.dirWidth > 0 ? truncate(formatDir(session.cwd), plan.dirWidth).padEnd(plan.dirWidth) : '';

  const target =
    plan.targetWidth > 0 ? truncate(session.target, plan.targetWidth).padEnd(plan.targetWidth) : '';

  const label = findMapValue(view.agentLabels, session.agent) ?? session.agent;
  const harness = truncate(label, plan.harnessWidth).padEnd(plan.harnessWidth);

  const resolved =
    session.model === null ? '' : resolveModelAlias(view.agentModels, session.agent, session.model);

  const model =
    plan.modelWidth > 0 ? truncate(resolved, plan.modelWidth).padEnd(plan.modelWidth) : '';

  const lifecycle = truncate(session.harness, plan.lifecycleWidth).padEnd(plan.lifecycleWidth);
  const event = truncate(session.lastMsg, plan.eventWidth).padEnd(plan.eventWidth);

  const cells = [name, directory, target, harness, model, lifecycle, event].filter(
    (cell) => cell !== '',
  );

  const body = cells.join(' ');
  const styledBody = sel ? `${ESC}[7m${body}${ESC}[0m` : body;
  const unread = session.unread ? `${ESC}[1;33m!${ESC}[0m` : ' ';
  const pin = session.pinned ? `${ESC}[93m⋆${ESC}[0m` : ' ';

  return {
    styled: `${GLYPH[session.state]}${unread}${pin} ${styledBody}`,
    width: 4 + body.length,
  };
}

export function drawOverlay(view: OverlayView, write: (chunk: string) => void = out) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, 'sessions')];

  if (view.sessions.length === 0) {
    const empty = view.filter === null ? 'no sessions — n to spawn' : 'no matches';

    rowsList.push(dimRow(width, empty));
  }

  // The harness label and the model each row would draw, so the columns
  // take the width of what is actually on screen.
  const harnessMax = Math.max(
    0,
    ...view.sessions.map(
      (session) => (findMapValue(view.agentLabels, session.agent) ?? session.agent).length,
    ),
  );

  const modelMax = Math.max(
    0,
    ...view.sessions.map((session) => {
      if (session.model === null) {
        return 0;
      }

      return resolveModelAlias(view.agentModels, session.agent, session.model).length;
    }),
  );

  const targetMax = Math.max(0, ...view.sessions.map((session) => session.target.length));

  const plan = planOverlayColumns({
    innerWidth: width - 4,
    grouped: view.grouped,
    showTarget: view.showTarget,
    targetMax,
    harnessMax,
    modelMax,
  });

  // the grouped view clusters sessions under dim repository headers, pinned ones first;
  // the flat view shows a directory column instead. A sub-session row follows its parent
  // indented and never opens a header.
  let lastKey: string | null = null;

  for (const [index, session] of view.sessions.entries()) {
    const sub = session.parent !== null && view.sessions.some((x) => x.id === session.parent);
    const key = session.pinned ? PINNED_GROUP_KEY : session.repoRoot;

    if (view.grouped && !sub && key !== lastKey) {
      lastKey = key;

      rowsList.push(dimRow(width, `▸ ${session.pinned ? 'pinned' : formatDir(session.repoRoot)}`));
    }

    const row = buildSessionRow(session, plan, view, index === view.selected);

    rowsList.push(boxRow(width, row.styled, row.width));
  }

  rowsList.push(boxDivider(width));

  if (view.filter !== null) {
    const pattern = truncate(view.filter, width - 8);

    rowsList.push(
      boxRow(width, `/ ${pattern}${ESC}[93m█${ESC}[0m`, 2 + pattern.length + 1),
      boxDivider(width),
    );
  }

  const selected = view.sessions[view.selected];
  let hint = buildOverlayHint(selected, view.sessions);

  if (view.stale) {
    hint += ' · u update daemon';
  }

  if (view.filter !== null) {
    hint = 'type to filter · ↑↓ move · ⏎ attach · esc clear';
  }

  if (view.confirmKill) {
    hint = formatKillConfirm(selected, view.sessions);
  }

  if (view.confirmDestroy) {
    hint = 'forget destroys its host and everything on it? y / n';
  }

  rowsList.push(dimRow(width, hint), boxBottom(width));

  drawBox(rowsList, write);
}

// A kill acts on the selected session's whole set, so the confirm counts
// the live sub-sessions that go with it; a forget counts the dead ones.
function formatKillConfirm(
  session: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[],
): string {
  const children = session === undefined ? [] : list.filter((x) => x.parent === session.id);
  const affected = children.filter((x) => x.alive === (session?.alive ?? false));

  if (affected.length === 0) {
    return 'kill selected session? y / n';
  }

  const noun = affected.length === 1 ? 'sub-session' : 'sub-sessions';

  return `kill selected session and its ${affected.length} ${noun}? y / n`;
}

const GLOBAL_HINT = 'g groups · n new · ? keys';

// Only the actions valid for the selected row appear; the full reference
// lives behind ?. Grok has no headless handoff, so H is omitted there. A
// sub-session's pin action targets its parent.
export function buildOverlayHint(
  session: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[] = [],
): string {
  if (session === undefined) {
    return GLOBAL_HINT;
  }

  const actions: string[] = [];

  if (session.kind === 'headless' && session.alive) {
    actions.push('P reattach', 'K kill');
  } else if (session.alive) {
    actions.push('⏎ attach');

    if (session.state === 'needs_you') {
      actions.push('a ack');
    }

    if (session.canEject) {
      actions.push('H headless');
    }

    actions.push('y yank', 'Y eject', 'K kill');
  } else {
    if (session.resumable) {
      actions.push('P revive', 'y yank');
    }

    actions.push('K forget');
  }

  const owner = pickPinTarget(session, list);
  const pinVerb = owner.pinned ? 'p unpin' : 'p pin';
  const pinAction = owner === session ? pinVerb : `${pinVerb} parent`;

  actions.push(pinAction);

  return `${actions.join(' · ')} ▏ ${GLOBAL_HINT}`;
}

export function drawHelp() {
  const width = Math.min(cols() - 4, 60);

  const lines = [
    '⏎  attach the selected session',
    '⇥  attach the most urgent needs-you, else latest done',
    'a  ack its notification without attaching',
    'H  eject to a headless run (Claude only)',
    'P  revive a dead or headless session',
    'y  yank the resume command to the clipboard',
    'Y  yank the resume command, then kill here',
    'K  kill (K again on a dead session forgets it)',
    'p  pin or unpin — pinned sessions stay on top',
    '    a sub-session pins with its parent unless pinned itself',
    'g  toggle grouping by repository',
    'n  new session',
    'r  adopt an external session',
    '/  filter · ↑↓/jk move · q quit',
  ];

  const rowsList: Row[] = [boxTop(width, 'keys')];

  for (const line of lines) {
    rowsList.push(boxRow(width, line, line.length));
  }

  rowsList.push(boxDivider(width), dimRow(width, 'esc/? back'), boxBottom(width));

  drawBox(rowsList, out);
}

export interface PickerView {
  title: string;
  items: readonly string[];
  selected: number;
  input: string;
  placeholder?: string;
  hint: string;

  // The indexes of items drawn dim: listed, but not a fit for the flow.
  dimmed?: ReadonlySet<number>;
}

export function drawPicker(view: PickerView, write: (chunk: string) => void = out) {
  const width = getPickerWidth();
  const rowsList: Row[] = [boxTop(width, view.title)];
  const shown = view.items.slice(0, 10);

  for (const [index, item] of shown.entries()) {
    const sel = index === view.selected;
    const truncated = truncate(item, width - 4);
    const dim = view.dimmed?.has(index) === true;
    const inverse = sel ? `${ESC}[7m${truncated.padEnd(width - 4)}${ESC}[0m` : truncated;
    const styled = dim ? `${ESC}[90m${inverse}${ESC}[0m` : inverse;
    const plainLen = sel ? width - 4 : truncated.length;

    rowsList.push(boxRow(width, styled, plainLen));
  }

  // The cursor always sits at the end of the input, so show the tail and
  // drop the head once the text outgrows the row.
  const inputMax = width - 8;

  const inputShown =
    view.input.length <= inputMax ? view.input : `…${view.input.slice(-(inputMax - 1))}`;

  let inputStyled: string;
  let inputLen: number;

  if (inputShown === '' && view.placeholder !== undefined && view.placeholder !== '') {
    const ph = truncate(view.placeholder, width - 8);

    inputStyled = `> ${ESC}[93m█${ESC}[0m${ESC}[90m ${ph}${ESC}[0m`;
    inputLen = 2 + 1 + 1 + ph.length;
  } else {
    inputStyled = `> ${inputShown}${ESC}[93m█${ESC}[0m`;
    inputLen = 2 + inputShown.length + 1;
  }

  rowsList.push(
    boxRow(width, inputStyled, inputLen),
    boxDivider(width),
    dimRow(width, view.hint),
    boxBottom(width),
  );

  drawBox(rowsList, write);
}

export function drawHome(fleetCount = 0, leaderLabel = '^Space') {
  out(ansi.clear + ansi.hideCursor);

  const msgs = [
    'atc — control tower for coding-agent sessions',
    '',
    'n       spawn a session',
    'r       adopt an existing session',
    ...(fleetCount > 0 ? [`R       restore last fleet (${fleetCount} sessions)`] : []),
    `${leaderLabel.padEnd(7)} session list`,
    'q       quit',
  ];

  const top = Math.max(1, Math.floor((rows() - 1 - msgs.length) / 2));

  for (const [index, line] of msgs.entries()) {
    const left = Math.max(1, Math.floor((cols() - line.length) / 2));
    const styled = index === 0 ? `${ESC}[1m${line}${ESC}[0m` : `${ESC}[90m${line}${ESC}[0m`;

    out(ansi.moveTo(top + index, left) + styled);
  }
}
