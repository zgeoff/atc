import { PINNED_GROUP_KEY } from '../protocol/pinned-group-key';
import type { SessionState } from '../protocol/session-state';
import type { AgentID } from '../shared/agent-id';
import { RESET_INPUT_MODES } from '../shared/reset-input-modes';
import { formatDir } from './dirs';
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

export const ansi = {
  altScreenOn: `${ESC}[?1049h`,
  resetInputModes: RESET_INPUT_MODES,
  altScreenOff: `${ESC}[?1049l`,
  clear: `${ESC}[2J${ESC}[H`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  saveCursor: `${ESC}7`,
  restoreCursor: `${ESC}8`,
  reset: `${ESC}[0m`,
  moveTo: (row: number, col: number) => `${ESC}[${row};${col}H`,
};

const GLYPH: Record<SessionState, string> = {
  needs_you: `${ESC}[31m●${ESC}[0m`,
  running: `${ESC}[36m◐${ESC}[0m`,
  done: `${ESC}[32m✓${ESC}[0m`,
  exited: `${ESC}[90m✗${ESC}[0m`,
};

function out(s: string) {
  process.stdout.write(s);
}

function truncate(s: string, max: number): string {
  // oxlint-disable-next-line no-control-regex -- stripping ANSI/newline control bytes is the point
  const clean = s.replaceAll(/[\r\n\u001B]+/gu, ' ');

  if (max <= 0) {
    return '';
  }

  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function cols(): number {
  return process.stdout.columns || 80;
}

/**
 * The width of the picker box, borders included. An item row holds 4
 * columns fewer.
 */
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
}

export function drawStatusBar(view: StatusView) {
  const c = view.counts;
  const width = cols();
  const left = ` atc ▏${view.focusedName ?? 'no session'} `;
  const parts: string[] = [];

  if (c.needs_you > 0) {
    const who = view.urgentName === null ? '' : `: ${view.urgentName}`;

    parts.push(`● ${c.needs_you} need you${who}`);
  }

  if (c.done > 0) {
    parts.push(`✓ ${c.done} done`);
  }

  if (c.running > 0) {
    parts.push(`◐ ${c.running} running`);
  }

  if (c.exited > 0) {
    parts.push(`✗ ${c.exited}`);
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
  const bg = c.needs_you > 0 ? `${ESC}[1;97;41m` : `${ESC}[30;47m`;
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
  const boxWidth = Math.max(...rowsList.map((r) => r.width));
  const top = Math.max(1, Math.floor((rows() - 1 - rowsList.length) / 2));
  const left = Math.max(1, Math.floor((cols() - boxWidth) / 2));
  const extent: BoxExtent = { top, height: rowsList.length };
  let buf = ansi.hideCursor;

  for (const row of planVacatedRows(lastBoxExtent, extent)) {
    buf += `${ansi.moveTo(row, 1)}${ESC}[2K`;
  }

  lastBoxExtent = extent;

  for (const [i, r] of rowsList.entries()) {
    buf += ansi.moveTo(top + i, left) + r.styled;
  }

  write(buf);
}

function boxTop(width: number, title: string): Row {
  const t = ` ${title} `;

  return { styled: `┌${t}${'─'.repeat(Math.max(0, width - 2 - t.length))}┐`, width };
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
  const t = truncate(text, width - 4);

  return boxRow(width, `${ESC}[90m${t}${ESC}[0m`, t.length);
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
function readMapValue<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// A session's model as the row draws it: the daemon answer's alias target,
// or the raw model string when the answer maps nothing for it.
function resolveModelAlias(
  models: Readonly<Record<AgentID, Readonly<Record<string, string>>>>,
  agent: AgentID,
  model: string,
): string {
  const aliases = readMapValue(models, agent);

  return aliases === undefined ? model : (readMapValue(aliases, model) ?? model);
}

// A session row draws status (the attention glyph plus the unread mark),
// pin, name, the flat view's directory, then the target, harness, model,
// harness lifecycle, and last event columns the width plan allows.
export function buildSessionRow(
  s: Readonly<OverlaySessionView>,
  plan: Readonly<OverlayColumnPlan>,
  view: Readonly<OverlayView>,
  sel: boolean,
): Row {
  const sub = s.parent !== null && view.sessions.some((x) => x.id === s.parent);

  const name =
    plan.nameWidth >= 4 && sub
      ? `↳ ${truncate(s.name, plan.nameWidth - 2)}`.padEnd(plan.nameWidth)
      : truncate(s.name, plan.nameWidth).padEnd(plan.nameWidth);

  const dir =
    plan.dirWidth > 0 ? truncate(formatDir(s.cwd), plan.dirWidth).padEnd(plan.dirWidth) : '';

  const target =
    plan.targetWidth > 0 ? truncate(s.target, plan.targetWidth).padEnd(plan.targetWidth) : '';

  const label = readMapValue(view.agentLabels, s.agent) ?? s.agent;
  const harness = truncate(label, plan.harnessWidth).padEnd(plan.harnessWidth);
  const resolved = s.model === null ? '' : resolveModelAlias(view.agentModels, s.agent, s.model);

  const model =
    plan.modelWidth > 0 ? truncate(resolved, plan.modelWidth).padEnd(plan.modelWidth) : '';

  const lifecycle = truncate(s.harness, plan.lifecycleWidth).padEnd(plan.lifecycleWidth);
  const event = truncate(s.lastMsg, plan.eventWidth).padEnd(plan.eventWidth);
  const cells = [name, dir, target, harness, model, lifecycle, event].filter((cell) => cell !== '');
  const body = cells.join(' ');
  const styledBody = sel ? `${ESC}[7m${body}${ESC}[0m` : body;
  const unread = s.unread ? `${ESC}[1;33m!${ESC}[0m` : ' ';
  const pin = s.pinned ? `${ESC}[93m⋆${ESC}[0m` : ' ';

  return {
    styled: `${GLYPH[s.state]}${unread}${pin} ${styledBody}`,
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
    ...view.sessions.map((s) => (readMapValue(view.agentLabels, s.agent) ?? s.agent).length),
  );

  const modelMax = Math.max(
    0,
    ...view.sessions.map((s) => {
      if (s.model === null) {
        return 0;
      }

      return resolveModelAlias(view.agentModels, s.agent, s.model).length;
    }),
  );

  const targetMax = Math.max(0, ...view.sessions.map((s) => s.target.length));

  const plan = planOverlayColumns({
    innerWidth: width - 4,
    grouped: view.grouped,
    showTarget: view.showTarget,
    targetMax,
    harnessMax,
    modelMax,
  });

  // The grouped view clusters sessions under dim repository headers, with
  // pinned sessions leading in their own cluster; the flat view shows a
  // directory column instead. The rows keep the sorted order either way. A
  // sub-session row follows its parent indented, and never opens a header.
  let lastKey: string | null = null;

  for (const [i, s] of view.sessions.entries()) {
    const sub = s.parent !== null && view.sessions.some((x) => x.id === s.parent);
    const key = s.pinned ? PINNED_GROUP_KEY : s.repoRoot;

    if (view.grouped && !sub && key !== lastKey) {
      lastKey = key;

      rowsList.push(dimRow(width, `▸ ${s.pinned ? 'pinned' : formatDir(s.repoRoot)}`));
    }

    const row = buildSessionRow(s, plan, view, i === view.selected);

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
  s: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[],
): string {
  const children = s === undefined ? [] : list.filter((x) => x.parent === s.id);
  const affected = children.filter((x) => x.alive === (s?.alive ?? false));

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
  s: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[] = [],
): string {
  if (s === undefined) {
    return GLOBAL_HINT;
  }

  const actions: string[] = [];

  if (s.kind === 'headless' && s.alive) {
    actions.push('P reattach', 'K kill');
  } else if (s.alive) {
    actions.push('⏎ attach');

    if (s.state === 'needs_you') {
      actions.push('a ack');
    }

    if (s.canEject) {
      actions.push('H headless');
    }

    actions.push('y yank', 'Y eject', 'K kill');
  } else {
    if (s.resumable) {
      actions.push('P revive', 'y yank');
    }

    actions.push('K forget');
  }

  const owner = (s.parent === null ? undefined : list.find((x) => x.id === s.parent)) ?? s;
  const pinVerb = owner.pinned ? 'p unpin' : 'p pin';
  const pinAction = owner === s ? pinVerb : `${pinVerb} parent`;

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
    '    a sub-session pins with its parent',
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

  for (const [i, item] of shown.entries()) {
    const sel = i === view.selected;
    const t = truncate(item, width - 4);
    const dim = view.dimmed?.has(i) === true;
    const inverse = sel ? `${ESC}[7m${t.padEnd(width - 4)}${ESC}[0m` : t;
    const styled = dim ? `${ESC}[90m${inverse}${ESC}[0m` : inverse;
    const plainLen = sel ? width - 4 : t.length;

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

  for (const [i, m] of msgs.entries()) {
    const left = Math.max(1, Math.floor((cols() - m.length) / 2));
    const styled = i === 0 ? `${ESC}[1m${m}${ESC}[0m` : `${ESC}[90m${m}${ESC}[0m`;

    out(ansi.moveTo(top + i, left) + styled);
  }
}
