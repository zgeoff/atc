import { basename } from 'node:path';
import { bootDaemonClient } from './boot-daemon';
import { loadConfig } from './config';
import { collectDirs, findFuzzyScore, formatDir, pickMatches } from './dirs';
import type { EventMsg } from './protocol';
import { isRecord } from './report';
import { countSessionStates, sortSessionViews } from './sessions';
import type { SessionState } from './sessions';
import { ansi, cols, drawHelp, drawHome, drawOverlay, drawPicker, drawStatusBar, rows } from './ui';

type Mode =
  | 'home'
  | 'attached'
  | 'overlay'
  | 'help'
  | 'picker-dir'
  | 'picker-name'
  | 'picker-prompt'
  | 'picker-eject';

interface MirrorSession {
  id: string;
  name: string;
  cwd: string;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  createdAt: number;
  kind: 'pty' | 'jsonl';
  alive: boolean;
  resumable: boolean;
}

let mode: Mode = 'home';
let overlaySelected = 0;
let confirmKill = false;

// The client's mirror of the daemon's fleet, kept fresh by events.
let fleet: MirrorSession[] = [];
let focusedID: string | null = null;
let fleetCount = 0;

// picker state carried across the dir -> name -> prompt steps
let allDirs: string[] = [];
let pickerInput = '';
let pickerSelected = 0;
let spawnDir = '';
let spawnName = '';
let spawnResume = false;
const stdout = process.stdout;

// Full height: the atc status bar only exists on home/overlay screens;
// attached sessions render fleet state via their own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}

function findFocused(): MirrorSession | null {
  return fleet.find((s) => s.id === focusedID) ?? null;
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStatus() {
  if (statusTimer !== null) {
    return;
  }

  statusTimer = setTimeout(() => {
    statusTimer = null;

    if (mode !== 'attached') {
      const focused = findFocused();
      const urgent = sortSessionViews(fleet).find((s) => s.state === 'needs_you');

      drawStatusBar({
        counts: countSessionStates(fleet),
        focusedName: focused === null ? null : focused.name,
        urgentName: urgent === undefined ? null : urgent.name,
        leaderLabel: leader.label,
      });
    }
  }, 50);
}

async function sendQuiet(m: string, p?: Readonly<Record<string, unknown>>) {
  try {
    await client.sendRequest(m, p);
  } catch {}
}

async function attach(sessionID: string) {
  focusedID = sessionID;
  mode = 'attached';

  stdout.write(ansi.clear + ansi.showCursor);

  try {
    await client.sendRequest('session.attach', {
      session: sessionID,
      cols: cols(),
      rows: ptyRows(),
    });
  } catch {
    mode = 'overlay';

    openOverlay();

    return;
  }

  scheduleStatus();
}

function detachFocused() {
  if (focusedID !== null) {
    void sendQuiet('session.detach', { session: focusedID });
  }
}

function toBase() {
  const f = findFocused();

  if (f !== null && f.alive) {
    mode = 'attached';

    stdout.write(ansi.clear + ansi.showCursor);
    void sendQuiet('session.attach', { session: f.id, cols: cols(), rows: ptyRows() });
  } else {
    mode = 'home';

    drawHome(fleetCount, leader.label);
  }

  scheduleStatus();
}

let ejectTarget = '';

async function yankToHeadless(instruction: string) {
  try {
    await client.sendRequest('session.eject', {
      session: ejectTarget,
      ...(instruction === '' ? {} : { prompt: instruction }),
    });
  } catch (error) {
    recordActionFailure(ejectTarget, error);
  }

  openOverlay();
}

async function adoptSession(id: string) {
  try {
    await client.sendRequest('session.adopt', { session: id, cols: cols(), rows: ptyRows() });

    await attach(id);
  } catch (error) {
    recordActionFailure(id, error);
    openOverlay();
  }
}

// A failed overlay action lands in the session's message column, so the
// reason is visible instead of the action silently doing nothing.
function recordActionFailure(id: string, error: unknown) {
  const s = fleet.find((x) => x.id === id);

  if (s !== undefined) {
    s.lastMsg = error instanceof Error ? error.message : String(error);
  }
}

function openHelp() {
  mode = 'help';

  stdout.write(ansi.clear);

  drawHelp();
}

function applyHelpKey(buf: Buffer) {
  const ch = buf.toString();

  if (buf[0] === KEY.esc || ch === '?' || ch === 'q' || buf[0] === leader.code) {
    openOverlay();
  }
}

// fzf-style overlay search: null when inactive, the pattern while active.
let overlayFilter: string | null = null;

function pickOverlaySessions(): MirrorSession[] {
  const sorted = sortSessionViews(fleet);

  if (overlayFilter === null || overlayFilter === '') {
    return sorted;
  }

  const f = overlayFilter;

  return sorted.filter((s) => findFuzzyScore(`${s.name} ${formatDir(s.cwd)}`, f) !== null);
}

function renderOverlay() {
  const sessions = pickOverlaySessions();

  overlaySelected = Math.max(0, Math.min(overlaySelected, sessions.length - 1));

  drawOverlay({
    sessions,
    selected: overlaySelected,
    confirmKill,
    filter: overlayFilter,
  });

  scheduleStatus();
}

function openOverlay() {
  mode = 'overlay';
  confirmKill = false;
  overlayFilter = null;

  const focusedIndex = sortSessionViews(fleet).findIndex((s) => s.id === focusedID);

  overlaySelected = Math.max(0, focusedIndex);

  stdout.write(ansi.clear);

  renderOverlay();
}

function renderPicker() {
  const verb = spawnResume ? 'adopt' : 'spawn';

  if (mode === 'picker-dir') {
    const items = pickMatches(allDirs, pickerInput).map((d) => formatDir(d));

    pickerSelected = Math.min(pickerSelected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker({
      title: `${verb}: directory`,
      items,
      selected: pickerSelected,
      input: pickerInput,
      hint: 'type to filter · ↑↓ move · ⏎ select · esc cancel',
    });
  } else if (mode === 'picker-name') {
    drawPicker({
      title: `${verb}: name`,
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: basename(spawnDir),
      hint: `session name for ${formatDir(spawnDir)} · ⏎ accept · esc back`,
    });
  } else if (mode === 'picker-eject') {
    drawPicker({
      title: 'eject: headless instruction',
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: 'continue the task autonomously',
      hint: 'instruction for the headless run · ⏎ eject · esc back',
    });
  } else {
    drawPicker({
      title: 'spawn: initial prompt',
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: 'optional — ⏎ to start interactive',
      hint: 'first message for the session · ⏎ spawn · esc back',
    });
  }

  scheduleStatus();
}

async function openDirPicker(resume = false) {
  spawnResume = resume;

  let recent: string[] = [];

  try {
    const answer = await client.sendRequest('dirs.list');

    const dirs = answer['dirs'];

    if (Array.isArray(dirs)) {
      recent = dirs.filter((d): d is string => typeof d === 'string');
    }
  } catch {}

  allDirs = await collectDirs(recent);

  pickerInput = '';
  pickerSelected = 0;
  mode = 'picker-dir';

  stdout.write(ansi.clear);

  renderPicker();
}

async function restoreFleet() {
  try {
    await client.sendRequest('fleet.restore', { cols: cols(), rows: ptyRows() });
  } catch {
    return;
  }

  const first = sortSessionViews(fleet).find((s) => s.alive);

  if (first !== undefined) {
    await attach(first.id);
  }
}

async function spawnFromPicker(prompt: string) {
  try {
    const ok = await client.sendRequest('session.spawn', {
      cwd: spawnDir,
      name: spawnName,
      prompt,
      cols: cols(),
      rows: ptyRows(),
      ...(spawnResume ? { resume: true } : {}),
    });

    const spawned = toMirrorSession(ok['session']);

    if (spawned !== null) {
      upsertMirror(spawned);

      await attach(spawned.id);

      return;
    }
  } catch {}

  toBase();
}

function quit(code = 0): never {
  detachFocused();

  client.stop();
  stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  process.exit(code);
}

const SESSION_STATES: readonly SessionState[] = ['running', 'needs_you', 'done', 'exited'];

function toMirrorSession(value: unknown): MirrorSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const state = SESSION_STATES.find((x) => x === value['state']);

  if (
    typeof value['id'] !== 'string' ||
    typeof value['name'] !== 'string' ||
    typeof value['cwd'] !== 'string' ||
    state === undefined ||
    typeof value['unread'] !== 'boolean' ||
    typeof value['lastMsg'] !== 'string' ||
    typeof value['createdAt'] !== 'number' ||
    typeof value['alive'] !== 'boolean'
  ) {
    return null;
  }

  return {
    id: value['id'],
    name: value['name'],
    cwd: value['cwd'],
    state,
    unread: value['unread'],
    lastMsg: value['lastMsg'],
    createdAt: value['createdAt'],
    kind: value['kind'] === 'jsonl' ? 'jsonl' : 'pty',
    alive: value['alive'],
    resumable: typeof value['claudeId'] === 'string',
  };
}

function upsertMirror(d: Readonly<MirrorSession>) {
  const existing = fleet.find((s) => s.id === d.id);

  if (existing === undefined) {
    fleet.push({ ...d });
  } else {
    existing.name = d.name;
    existing.state = d.state;
    existing.unread = d.unread;
    existing.lastMsg = d.lastMsg;
    existing.kind = d.kind;
    existing.alive = d.alive;
    existing.resumable = d.resumable;
  }
}

function refreshScreens() {
  if (mode === 'overlay') {
    renderOverlay();
  }

  // Focused session died under us: surface the list instead of a dead screen.
  const f = findFocused();

  if (mode === 'attached' && f !== null && f.state === 'exited') {
    openOverlay();
  }

  scheduleStatus();
}

function applyDaemonEvent(e: EventMsg) {
  switch (e.ev) {
    case 'session.output': {
      if (mode === 'attached' && e['s'] === focusedID && typeof e['d'] === 'string') {
        stdout.write(e['d']);
      }

      return;
    }
    case 'session.added': {
      const d = toMirrorSession(e['session']);

      if (d !== null) {
        upsertMirror(d);
      }

      refreshScreens();

      return;
    }
    case 'session.state': {
      const s = fleet.find((x) => x.id === e['s']);

      if (s !== undefined) {
        const next = SESSION_STATES.find((x) => x === e['state']);

        if (next !== undefined) {
          s.state = next;
        }

        if (typeof e['alive'] === 'boolean') {
          s.alive = e['alive'];
        } else if (next === 'exited') {
          s.alive = false;
        }

        if (e['kind'] === 'pty' || e['kind'] === 'jsonl') {
          s.kind = e['kind'];
        }

        if (typeof e['unread'] === 'boolean') {
          s.unread = e['unread'];
        }

        if (typeof e['lastMsg'] === 'string') {
          s.lastMsg = e['lastMsg'];
        }

        if (typeof e['claudeId'] === 'string') {
          s.resumable = true;
        }
      }

      refreshScreens();

      return;
    }
    case 'session.renamed': {
      const s = fleet.find((x) => x.id === e['s']);

      if (s !== undefined && typeof e['name'] === 'string') {
        s.name = e['name'];
      }

      refreshScreens();

      return;
    }
    case 'session.removed': {
      fleet = fleet.filter((x) => x.id !== e['s']);

      if (focusedID === e['s']) {
        focusedID = null;
      }

      refreshScreens();
      break;
    }

    // Desync recovery arrives as ordinary repaint output; permission
    // events matter to structured clients, not this passthrough TUI.
    default:
  }
}

// Best-effort clipboard: OSC 52 (works through zellij/tmux/ssh) plus any
// local clipboard helper that exists.
function copyToClipboard(text: string) {
  stdout.write(`\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`);

  for (const cmd of [['clip.exe'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]) {
    try {
      const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

      void proc.stdin.write(text);
      void proc.stdin.end();
      break;
    } catch {}
  }
}

// ---- input ----

const leader = loadConfig().leader;

const KEY = {
  tab: 0x09,
  ctrlC: 0x03,
  ctrlU: 0x15,
  esc: 0x1b,
  enter: 0x0d,
  backspace: 0x7f,
} as const;

function isUp(buf: Buffer): boolean {
  return buf.toString() === '\u001B[A' || buf.toString() === '\u001BOA';
}

function isDown(buf: Buffer): boolean {
  return buf.toString() === '\u001B[B' || buf.toString() === '\u001BOB';
}

function applyOverlayFilterKey(buf: Buffer): boolean {
  if (overlayFilter === null) {
    return false;
  }

  // esc clears the filter but stays in the overlay; enter falls through to
  // the normal handler so it attaches the selected match.
  if (buf[0] === KEY.esc && buf.length === 1) {
    overlayFilter = null;

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.backspace) {
    overlayFilter = overlayFilter.slice(0, -1);

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.ctrlU) {
    overlayFilter = '';

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.enter || isUp(buf) || isDown(buf) || buf[0] === leader.code) {
    return false;
  }

  const text = buf.toString();
  let printable = text.length > 0;

  for (const c of text) {
    if (c < ' ' || c === '\u007F') {
      printable = false;
      break;
    }
  }

  if (printable) {
    overlayFilter += text;

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  return true;
}

function applyOverlayKey(buf: Buffer) {
  const filtered = pickOverlaySessions();
  const sel = filtered[overlaySelected];

  if (confirmKill) {
    if (buf[0] === 0x79 /* y */ && sel !== undefined) {
      void sendQuiet('session.kill', { session: sel.id });
    }

    confirmKill = false;

    renderOverlay();

    return;
  }

  if (applyOverlayFilterKey(buf)) {
    return;
  }

  if (buf.toString() === '/') {
    overlayFilter = '';
    overlaySelected = 0;

    stdout.write(ansi.clear);

    renderOverlay();

    return;
  }

  if (buf[0] === leader.code || (buf[0] === KEY.esc && buf.length === 1)) {
    toBase();

    return;
  }

  if (isDown(buf) || buf.toString() === 'j') {
    overlaySelected = Math.min(filtered.length - 1, overlaySelected + 1);

    renderOverlay();

    return;
  }

  if (isUp(buf) || buf.toString() === 'k') {
    overlaySelected = Math.max(0, overlaySelected - 1);

    renderOverlay();

    return;
  }

  const ch = buf.toString();

  if (buf[0] === KEY.tab) {
    const needy = sortSessionViews(fleet).find((s) => s.state === 'needs_you' && s.alive);

    if (needy !== undefined) {
      void attach(needy.id);
    }

    return;
  }

  if (buf[0] === KEY.enter && sel !== undefined && sel.alive) {
    void attach(sel.id);

    return;
  }

  if (ch === 'a' && sel !== undefined) {
    void sendQuiet('session.ack', { session: sel.id });
    renderOverlay();

    return;
  }

  if (ch === 'n') {
    void openDirPicker();

    return;
  }

  if (ch === '?') {
    openHelp();

    return;
  }

  if (ch === 'H' && sel !== undefined && sel.kind === 'pty' && sel.alive) {
    ejectTarget = sel.id;
    pickerInput = '';
    mode = 'picker-eject';

    stdout.write(ansi.clear);

    renderPicker();

    return;
  }

  if (ch === 'P' && sel !== undefined && sel.resumable && (sel.kind === 'jsonl' || !sel.alive)) {
    void adoptSession(sel.id);

    return;
  }

  if (ch === 'r') {
    void openDirPicker(true);

    return;
  }

  if ((ch === 'y' || ch === 'Y') && sel !== undefined) {
    void yankResume(sel.id, ch === 'Y');

    return;
  }

  if (ch === 'K' && sel !== undefined) {
    confirmKill = true;

    renderOverlay();

    return;
  }

  if (ch === 'q' || buf[0] === KEY.ctrlC) {
    quit();
  }
}

async function yankResume(sessionID: string, eject: boolean) {
  try {
    const answer = await client.sendRequest('session.resumeCommand', { session: sessionID });

    const command = answer['command'];

    if (typeof command !== 'string') {
      return;
    }

    copyToClipboard(command);

    const s = fleet.find((x) => x.id === sessionID);

    if (s !== undefined) {
      s.lastMsg = 'resume cmd copied';
    }

    // Eject hands the session off entirely.
    if (eject) {
      void sendQuiet('session.kill', { session: sessionID });
    }

    if (mode === 'overlay') {
      renderOverlay();
    }
  } catch {}
}

function applyTextKey(buf: Buffer, onSubmit: () => void, onCancel: () => void) {
  // Pasted chunks arrive as one buffer: split into per-char events so a
  // trailing newline still submits. Escape sequences stay intact.
  if (buf.length > 1 && buf[0] !== KEY.esc) {
    for (const ch of buf.toString()) {
      applyTextKey(Buffer.from(ch), onSubmit, onCancel);

      if (mode === 'attached' || ch === '\r') {
        return;
      }
    }

    return;
  }

  if (buf[0] === KEY.esc && buf.length === 1) {
    onCancel();

    return;
  }

  if (buf[0] === leader.code) {
    toBase();

    return;
  }

  if (buf[0] === KEY.enter) {
    onSubmit();

    return;
  }

  if (buf[0] === KEY.backspace) {
    pickerInput = pickerInput.slice(0, -1);

    renderPicker();

    return;
  }

  if (buf[0] === KEY.ctrlU) {
    pickerInput = '';

    renderPicker();

    return;
  }

  if (mode === 'picker-dir') {
    if (isDown(buf)) {
      pickerSelected++;

      renderPicker();

      return;
    }

    if (isUp(buf)) {
      pickerSelected = Math.max(0, pickerSelected - 1);

      renderPicker();

      return;
    }
  }

  const text = buf.toString();
  let printable = true;

  for (const c of text) {
    if (c < ' ' || c === '\u007F') {
      printable = false;
      break;
    }
  }

  if (printable) {
    pickerInput += text;

    renderPicker();
  }
}

const client = await bootDaemonClient();

client.onEvent = applyDaemonEvent;

{
  const list = await client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (Array.isArray(sessions)) {
    for (const raw of sessions) {
      const d = toMirrorSession(raw);

      if (d !== null) {
        upsertMirror(d);
      }
    }
  }

  const answer = await client.sendRequest('fleet.list').catch(() => ({}) as const);

  const entries = (answer as Record<string, unknown>)['fleet'];

  fleetCount = Array.isArray(entries) ? entries.length : 0;
}

process.stdin.setRawMode(true);
process.stdin.resume();

// Stateful decode for the stdin -> daemon path: a multi-byte character split
// across two stdin reads must not be mangled by per-chunk toString().
const stdinDecoder = new TextDecoder('utf-8');

process.stdin.on('data', (buf: Buffer) => {
  switch (mode) {
    case 'attached': {
      if (buf[0] === leader.code && buf.length === 1) {
        openOverlay();

        return;
      }

      if (focusedID !== null) {
        void sendQuiet('session.input', {
          session: focusedID,
          d: stdinDecoder.decode(buf, { stream: true }),
        });
      }

      return;
    }
    case 'home': {
      if (buf[0] === leader.code) {
        openOverlay();

        return;
      }

      const ch = buf.toString();

      if (ch === 'n') {
        void openDirPicker();

        return;
      }

      if (ch === 'r') {
        void openDirPicker(true);

        return;
      }

      if (ch === 'R') {
        void restoreFleet();

        return;
      }

      if (ch === 'q' || buf[0] === KEY.ctrlC) {
        quit();
      }

      return;
    }
    case 'overlay': {
      applyOverlayKey(buf);

      return;
    }
    case 'help': {
      applyHelpKey(buf);

      return;
    }
    case 'picker-dir': {
      applyTextKey(
        buf,
        () => {
          const items = pickMatches(allDirs, pickerInput);
          const raw = pickerInput.trim();
          let chosen = items[pickerSelected] ?? null;

          if (chosen === null && (raw.startsWith('/') || raw.startsWith('~'))) {
            chosen = raw.replace(/^~/u, process.env['HOME'] ?? '~');
          }

          if (chosen === null) {
            return;
          }

          spawnDir = chosen;
          pickerInput = '';
          mode = 'picker-name';

          stdout.write(ansi.clear);

          renderPicker();
        },
        () => {
          toBase();
        },
      );

      return;
    }
    case 'picker-name': {
      applyTextKey(
        buf,
        () => {
          spawnName = pickerInput.trim();
          pickerInput = '';

          // Adopt skips the prompt step: claude --resume opens its own
          // session picker inside the new PTY.
          if (spawnResume) {
            void spawnFromPicker('');

            return;
          }

          mode = 'picker-prompt';

          stdout.write(ansi.clear);

          renderPicker();
        },
        () => {
          pickerInput = '';
          mode = 'picker-dir';

          stdout.write(ansi.clear);

          renderPicker();
        },
      );

      return;
    }
    case 'picker-prompt': {
      applyTextKey(
        buf,
        () => {
          void spawnFromPicker(pickerInput.trim());
        },
        () => {
          pickerInput = '';
          mode = 'picker-name';

          stdout.write(ansi.clear);

          renderPicker();
        },
      );

      return;
    }
    case 'picker-eject': {
      applyTextKey(
        buf,
        () => {
          void yankToHeadless(pickerInput.trim());
        },
        () => {
          openOverlay();
        },
      );
    }
  }
});

stdout.on('resize', () => {
  if (mode === 'attached' && focusedID !== null) {
    void sendQuiet('session.resize', { session: focusedID, cols: cols(), rows: ptyRows() });
  }

  if (mode === 'home') {
    drawHome(fleetCount, leader.label);
  }

  if (mode === 'overlay') {
    stdout.write(ansi.clear);

    renderOverlay();
  }

  if (mode.startsWith('picker')) {
    stdout.write(ansi.clear);

    renderPicker();
  }

  scheduleStatus();
});

process.on('uncaughtException', (err) => {
  stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  console.error(err);
  process.exit(1);
});

process.on('SIGTERM', () => quit());
process.on('SIGHUP', () => quit());

// ---- start ----
stdout.write(ansi.altScreenOn);

drawHome(fleetCount, leader.label);
scheduleStatus();
