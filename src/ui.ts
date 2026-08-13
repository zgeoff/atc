import { formatDir } from './dirs';
import type { SessionState } from './sessions';

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

const STATE_LABEL: Record<SessionState, string> = {
  needs_you: 'NEEDS YOU',
  running: 'running',
  done: 'done',
  exited: 'exited',
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

export function rows(): number {
  return process.stdout.rows || 24;
}

export interface StatusView {
  readonly counts: Readonly<Record<SessionState, number>>;
  readonly focusedName: string | null;
  readonly urgentName: string | null;
  readonly leaderLabel: string;
  readonly stale: boolean;
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

  if (view.stale) {
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

function drawBox(rowsList: readonly Row[]) {
  const boxWidth = Math.max(...rowsList.map((r) => r.width));
  const top = Math.max(1, Math.floor((rows() - 1 - rowsList.length) / 2));
  const left = Math.max(1, Math.floor((cols() - boxWidth) / 2));
  let buf = ansi.hideCursor;

  for (const [i, r] of rowsList.entries()) {
    buf += ansi.moveTo(top + i, left) + r.styled;
  }

  out(buf);
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
  readonly alive: boolean;
  readonly kind: 'pty' | 'jsonl';
  readonly resumable: boolean;
  readonly group?: string;
}

export interface OverlayView {
  sessions: readonly OverlaySessionView[];
  selected: number;
  confirmKill: boolean;
  filter: string | null;
  stale: boolean;
}

export function drawOverlay(view: OverlayView) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, 'sessions')];

  if (view.sessions.length === 0) {
    const empty = view.filter === null ? 'no sessions — n to spawn' : 'no matches';

    rowsList.push(dimRow(width, empty));
  }

  // Sessions cluster under dim headers when more than one group exists: an
  // explicit group wins, sessions without one fall back to their spawn
  // directory. The rows keep the sorted order, so urgent groups lead.
  const grouped = new Set(view.sessions.map((s) => s.group ?? s.cwd)).size > 1;
  let lastKey: string | null = null;

  for (const [i, s] of view.sessions.entries()) {
    const key = s.group ?? s.cwd;

    if (grouped && key !== lastKey) {
      lastKey = key;

      rowsList.push(dimRow(width, `▸ ${s.group ?? formatDir(s.cwd)}`));
    }

    const sel = i === view.selected;
    const name = truncate(s.name, 16).padEnd(16);
    const state = STATE_LABEL[s.state].padEnd(9);
    const dir = grouped ? '' : ` ${truncate(formatDir(s.cwd), 18).padEnd(18)}`;
    const msgWidth = Math.max(4, width - 4 - 2 - 17 - 10 - (grouped ? 0 : 19));
    const msg = truncate(s.lastMsg, msgWidth).padEnd(msgWidth);
    const unread = s.unread ? `${ESC}[1;33m!${ESC}[0m` : ' ';
    const body = `${name} ${state}${dir} ${msg}`;
    const styledBody = sel ? `${ESC}[7m${body}${ESC}[0m` : body;

    rowsList.push(boxRow(width, `${GLYPH[s.state]}${unread}${styledBody}`, 2 + body.length));
  }

  rowsList.push(boxDivider(width));

  if (view.filter !== null) {
    const pattern = truncate(view.filter, width - 8);

    rowsList.push(
      boxRow(width, `/ ${pattern}${ESC}[93m█${ESC}[0m`, 2 + pattern.length + 1),
      boxDivider(width),
    );
  }

  let hint = buildOverlayHint(view.sessions[view.selected]);

  if (view.stale) {
    hint += ' · u update daemon';
  }

  if (view.filter !== null) {
    hint = 'type to filter · ↑↓ move · ⏎ attach · esc clear';
  }

  if (view.confirmKill) {
    hint = 'kill selected session? y / n';
  }

  rowsList.push(dimRow(width, hint), boxBottom(width));

  drawBox(rowsList);
}

const GLOBAL_HINT = 'n new · ? keys';

// Only the actions valid for the selected row appear; the full reference
// lives behind ?.
function buildOverlayHint(s: OverlaySessionView | undefined): string {
  if (s === undefined) {
    return GLOBAL_HINT;
  }

  const actions: string[] = [];

  if (s.kind === 'jsonl' && s.alive) {
    actions.push('P reattach', 'K kill');
  } else if (s.alive) {
    actions.push('⏎ attach');

    if (s.state === 'needs_you') {
      actions.push('a ack');
    }

    actions.push('H headless', 'y yank', 'Y eject', 'K kill');
  } else {
    if (s.resumable) {
      actions.push('P revive', 'y yank');
    }

    actions.push('K forget');
  }

  return `${actions.join(' · ')} ▏ ${GLOBAL_HINT}`;
}

export function drawHelp() {
  const width = Math.min(cols() - 4, 60);

  const lines = [
    '⏎  attach the selected session',
    '⇥  attach the most urgent needs-you session',
    'a  ack its notification without attaching',
    'H  eject to a headless run',
    'P  revive a dead or headless session',
    'y  yank the resume command to the clipboard',
    'Y  yank the resume command, then kill here',
    'K  kill (K again on a dead session forgets it)',
    'n  new session',
    'r  adopt an external session',
    '/  filter · ↑↓/jk move · q quit',
  ];

  const rowsList: Row[] = [boxTop(width, 'keys')];

  for (const line of lines) {
    rowsList.push(boxRow(width, line, line.length));
  }

  rowsList.push(boxDivider(width), dimRow(width, 'esc/? back'), boxBottom(width));

  drawBox(rowsList);
}

export interface PickerView {
  title: string;
  items: readonly string[];
  selected: number;
  input: string;
  placeholder?: string;
  hint: string;
}

export function drawPicker(view: PickerView) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, view.title)];
  const shown = view.items.slice(0, 10);

  for (const [i, item] of shown.entries()) {
    const sel = i === view.selected;
    const t = truncate(item, width - 4);
    const styled = sel ? `${ESC}[7m${t.padEnd(width - 4)}${ESC}[0m` : t;
    const plainLen = sel ? width - 4 : t.length;

    rowsList.push(boxRow(width, styled, plainLen));
  }

  const inputShown = truncate(view.input, width - 8);
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

  drawBox(rowsList);
}

export function drawHome(fleetCount = 0, leaderLabel = '^Space') {
  out(ansi.clear + ansi.hideCursor);

  const msgs = [
    'atc — control tower for claude sessions',
    '',
    'n       spawn a session',
    'r       adopt an existing session (claude --resume)',
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
