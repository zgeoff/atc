import { match } from 'ts-pattern';
import { createActor } from 'xstate';
import { countSessionStates } from '../protocol/count-session-states';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import type { EventMsg } from '../protocol/protocol';
import { sortGroupedSessionViews } from '../protocol/sort-grouped-session-views';
import { sortSessionViews } from '../protocol/sort-session-views';
import type { AgentID } from '../shared/agent-id';
import { configFile, loadConfig } from '../shared/config';
import { makeSingleFlight } from '../shared/make-single-flight';
import { readManagedDaemonUnit } from '../shared/read-managed-daemon-unit';
import { restartManagedDaemon } from '../shared/restart-managed-daemon';
import { bootDaemonClient } from './boot-daemon';
import { buildClientMachine } from './build-client-machine';
import { buildLeaderChords } from './build-leader-chords';
import { collectTargetPicks } from './collect-target-picks';
import { findFuzzyScore, formatDir } from './dirs';
import type { ProtocolMismatch } from './format-protocol-mismatch';
import { KEY, isDown, isUp, planTextEdit } from './keys';
import { logClientEvent } from './log-client-event';
import { parseDaemonEvent } from './parse-daemon-event';
import { pickTabTarget } from './pick-tab-target';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { SpawnPicker } from './spawn-picker';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import { ansi, cols, drawHelp, drawHome, drawOverlay, drawPicker, drawStatusBar, rows } from './ui';

let overlaySelected = 0;
let confirmKill = false;

// The session whose forget waits on a confirm because it destroys the
// session's host, or null.
let confirmDestroyID: string | null = null;

// The client's mirror of the daemon's fleet, kept fresh by events.
let fleet: MirrorSession[] = [];

// When each session last flipped to done, so the Tab jump can prefer the
// most recently finished turn. Sessions already done before this client
// connected have no entry and rank last.
const doneAt = new Map<string, number>();

let focusedID: string | null = null;
let fleetCount = 0;
let lastUsedAgent: AgentID = loadConfig().defaultAgent;

// The readable harness label and tier-alias map per agent: the config alone
// until the daemon's `agents.list` answer arrives and re-resolves them
// whenever the overlay opens, so a backend configured after this client
// started still lists under its name.
const bootMetadata = resolveAgentMetadata(loadConfig(), {});
let agentLabels: Readonly<Record<AgentID, string>> = bootMetadata.labels;
let agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>> = bootMetadata.models;

// How many execution targets the daemon could spawn on right now; the
// target column appears once more than one is available.
let availableTargets = 0;
const stdout = process.stdout;

// Full height: the atc status bar only exists on home/overlay screens;
// attached sessions render fleet state via their own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}

function findFocused(): MirrorSession | null {
  return fleet.find((s) => s.id === focusedID) ?? null;
}

function openHome() {
  drawHome(fleetCount, leader.label);
  scheduleStatus();
}

function openAttached(sessionID: string) {
  focusedID = sessionID;

  stdout.write(ansi.clear + ansi.showCursor);

  scheduleStatus();
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStatus() {
  if (statusTimer !== null) {
    return;
  }

  statusTimer = setTimeout(() => {
    statusTimer = null;

    if (service.getSnapshot().value !== 'attached') {
      const focused = findFocused();
      const urgent = sortSessionViews(fleet).find((s) => s.state === 'needs_you');

      drawStatusBar({
        counts: countSessionStates(fleet),
        focusedName: focused === null ? null : focused.name,
        urgentName: urgent === undefined ? null : urgent.name,
        leaderLabel: leader.label,
        stale: daemonStale,
        restarting: daemonRestarting,
        waiting: daemonWaiting,
      });
    }
  }, 50);
}

async function sendQuiet(m: string, p?: Readonly<Record<string, unknown>>) {
  try {
    await client.sendRequest(m, p);
  } catch {}
}

// A kill the daemon refuses because forgetting the session destroys its
// host asks once more before the forget.
async function sendKill(sessionID: string) {
  try {
    await client.sendRequest('session.kill', { session: sessionID });
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'confirmation_required') {
      confirmDestroyID = sessionID;

      if (service.getSnapshot().value === 'overlay') {
        renderOverlay();
      }
    }
  }
}

// Takes the confirm token the daemon offers and hands it straight back:
// the operator already confirmed in the overlay.
async function sendForget(sessionID: string) {
  try {
    const offered = await client.sendRequest('session.forget', { session: sessionID });

    const confirmToken = offered['confirmToken'];

    if (typeof confirmToken === 'string') {
      await client.sendRequest('session.forget', { session: sessionID, confirmToken });
    }
  } catch {}
}

async function attach(sessionID: string) {
  service.send({ type: 'ATTACH', sessionID });

  try {
    await client.sendRequest('session.attach', {
      session: sessionID,
      cols: cols(),
      rows: ptyRows(),
    });
  } catch {
    service.send({ type: 'OVERLAY' });
  }
}

function detachFocused() {
  if (focusedID !== null) {
    void sendQuiet('session.detach', { session: focusedID });
  }
}

function toBase() {
  const f = findFocused();

  if (f !== null && f.alive) {
    service.send({ type: 'ATTACH', sessionID: f.id });
    void sendQuiet('session.attach', { session: f.id, cols: cols(), rows: ptyRows() });
  } else {
    service.send({ type: 'HOME' });
  }
}

let ejectTarget = '';
let ejectInput = '';

async function yankToHeadless(instruction: string) {
  try {
    await client.sendRequest('session.eject', {
      session: ejectTarget,
      ...(instruction === '' ? {} : { prompt: instruction }),
    });
  } catch (error) {
    recordActionFailure(ejectTarget, error);
  }

  service.send({ type: 'OVERLAY' });
}

async function adoptSession(id: string) {
  try {
    await client.sendRequest('session.adopt', { session: id, cols: cols(), rows: ptyRows() });

    await attach(id);
  } catch (error) {
    recordActionFailure(id, error);

    service.send({ type: 'OVERLAY' });
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
  stdout.write(ansi.clear);

  drawHelp();
}

function applyHelpKey(buf: Buffer) {
  const ch = buf.toString();

  if (buf[0] === KEY.esc || ch === '?' || ch === 'q' || isLeaderKey(buf)) {
    service.send({ type: 'OVERLAY' });
  }
}

// fzf-style overlay search: null when inactive, the pattern while active.
let overlayFilter: string | null = null;

// Flat list by default; g toggles clustering under repository headers.
let overlayGrouped = false;

function pickOverlaySessions(): MirrorSession[] {
  const sorted = overlayGrouped ? sortGroupedSessionViews(fleet) : sortSessionViews(fleet);

  if (overlayFilter === null || overlayFilter === '') {
    return sorted;
  }

  const f = overlayFilter;

  const matched = new Set(
    sorted
      .filter((s) => findFuzzyScore(`${s.name} ${formatDir(s.cwd)}`, f) !== null)
      .map((s) => s.id),
  );

  // A matching sub-session keeps its parent row, so it stays nested.
  return sorted.filter(
    (s) => matched.has(s.id) || sorted.some((c) => c.parent === s.id && matched.has(c.id)),
  );
}

function renderOverlay() {
  const sessions = pickOverlaySessions();

  overlaySelected = Math.max(0, Math.min(overlaySelected, sessions.length - 1));

  drawOverlay({
    sessions,
    agentLabels,
    agentModels,
    showTarget: availableTargets >= 2,
    selected: overlaySelected,
    confirmKill,
    confirmDestroy: confirmDestroyID !== null,
    filter: overlayFilter,
    stale: daemonStale && !daemonRestarting,
    grouped: overlayGrouped,
  });

  scheduleStatus();
}

// Rereads what the overlay labels rows with: each agent's readable name and
// tier aliases, and which execution targets can take a spawn. Target
// availability moves as remote hosts wake and sleep, so the overlay refresh
// keeps the column honest rather than trusting the boot-time answer.
async function refreshAgents() {
  try {
    const answer = await client.sendRequest('agents.list');

    const meta = resolveAgentMetadata(loadConfig(), answer);

    agentLabels = meta.labels;
    agentModels = meta.models;
    availableTargets = collectTargetPicks(answer).filter((t) => t.available).length;
  } catch {
    return;
  }

  if (service.getSnapshot().value === 'overlay') {
    renderOverlay();
  }
}

function openOverlay() {
  confirmKill = false;
  confirmDestroyID = null;
  overlayFilter = null;
  void refreshAgents();
  const focusedIndex = pickOverlaySessions().findIndex((s) => s.id === focusedID);

  overlaySelected = Math.max(0, focusedIndex);

  stdout.write(ansi.resetInputModes + ansi.clear);

  renderOverlay();
}

function renderEject() {
  drawPicker({
    title: 'eject: headless instruction',
    items: [],
    selected: -1,
    input: ejectInput,
    placeholder: 'continue the task autonomously',
    hint: 'instruction for the headless run · ⏎ eject · esc back',
  });

  scheduleStatus();
}

function openEject(sessionID: string) {
  ejectTarget = sessionID;
  ejectInput = '';

  stdout.write(ansi.clear);

  renderEject();
}

const picker = new SpawnPicker<MirrorSession>({
  sendRequest,
  ptyRows,
  isLeaderKey,
  getLastUsedAgent,
  scheduleStatus,
  toBase,
  attach,
  toMirrorSession,
  upsertMirror,
  hasDaemonFeature,
  write: (chunk) => {
    process.stdout.write(chunk);
  },
  cwd: process.cwd(),
  configPath: configFile,
  onDropAnswer: (kind) => {
    logClientEvent(`dropped ${kind} answer`);
  },
  log: logClientEvent,
});

function openPicker(resume: boolean) {
  picker.open(resume);
}

function hasDaemonFeature(feature: DaemonFeature): boolean {
  return daemonFeatures.has(feature);
}

function sendRequest(m: string, p?: Readonly<Record<string, unknown>>) {
  return client.sendRequest(m, p);
}

function getLastUsedAgent(): AgentID {
  return lastUsedAgent;
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

function quit(code = 0): never {
  detachFocused();

  client.onClose = () => {};

  client.stop();
  stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  process.exit(code);
}

function upsertMirror(d: Readonly<MirrorSession>) {
  const existing = fleet.find((s) => s.id === d.id);

  if (existing === undefined) {
    fleet.push({ ...d });
  } else {
    existing.name = d.name;
    existing.pinned = d.pinned;
    existing.lastAttachedAt = d.lastAttachedAt;
    existing.repoRoot = d.repoRoot;
    existing.state = d.state;
    existing.unread = d.unread;
    existing.lastMsg = d.lastMsg;
    existing.kind = d.kind;
    existing.alive = d.alive;
    existing.resumable = d.resumable;
    existing.canEject = d.canEject;
    existing.agent = d.agent;
    existing.target = d.target;
    existing.model = d.model;
    existing.harness = d.harness;
  }
}

function refreshScreens() {
  const currentMode = service.getSnapshot().value;

  if (currentMode === 'overlay') {
    renderOverlay();
  }

  // Focused session died under us: surface the list instead of a dead screen.
  const f = findFocused();

  if (currentMode === 'attached' && f !== null && f.state === 'exited') {
    service.send({ type: 'OVERLAY' });
  }

  scheduleStatus();
}

function applyDaemonEvent(raw: EventMsg) {
  const event = parseDaemonEvent(raw);

  if (event === null) {
    return;
  }

  match(event)
    .with({ ev: 'SessionOutput' }, (e) => {
      if (service.getSnapshot().value === 'attached' && e.s === focusedID) {
        stdout.write(e.d);
      }
    })
    .with({ ev: 'SessionAdded' }, (e) => {
      upsertMirror(e.session);
      refreshScreens();
    })
    .with({ ev: 'SessionState' }, (e) => {
      const existing = fleet.find((x) => x.id === e.session.id);

      if (existing !== undefined) {
        if (e.session.state === 'done' && existing.state !== 'done') {
          doneAt.set(e.session.id, Date.now());
        }

        if (e.session.resumable && !existing.resumable) {
          lastUsedAgent = e.session.agent;
        }
      }

      upsertMirror(e.session);
      refreshScreens();
    })
    .with({ ev: 'SessionRenamed' }, (e) => {
      const s = fleet.find((x) => x.id === e.s);

      if (s !== undefined) {
        s.name = e.name;
      }

      refreshScreens();
    })
    .with({ ev: 'SessionRemoved' }, (e) => {
      fleet = fleet.filter((x) => x.id !== e.s);

      doneAt.delete(e.s);

      if (focusedID === e.s) {
        focusedID = null;
      }

      refreshScreens();
    })

    // Desync recovery arrives as ordinary repaint output; permission and
    // resize events matter to structured clients, not this passthrough TUI.
    .with(
      { ev: 'SessionResized' },
      { ev: 'SessionDesync' },
      { ev: 'PermissionRequested' },
      { ev: 'PermissionResolved' },
      () => {},
    )
    .exhaustive();
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
const leaderChords = buildLeaderChords(leader.code);

// A fullscreen session can leave the terminal in an enhanced keyboard
// encoding, so the leader arrives as a CSI chord instead of its bare byte.
function isLeaderKey(buf: Buffer): boolean {
  return leaderChords.includes(buf.toString());
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

  if (buf[0] === KEY.enter || isUp(buf) || isDown(buf) || isLeaderKey(buf)) {
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
      void sendKill(sel.id);
    }

    confirmKill = false;

    renderOverlay();

    return;
  }

  if (confirmDestroyID !== null) {
    if (buf[0] === 0x79 /* y */) {
      void sendForget(confirmDestroyID);
    }

    confirmDestroyID = null;

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

  if (isLeaderKey(buf) || (buf[0] === KEY.esc && buf.length === 1)) {
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
    const target = pickTabTarget(fleet, (id) => doneAt.get(id));

    if (target !== undefined) {
      void attach(target.id);
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
    service.send({ type: 'SPAWN', resume: false });

    return;
  }

  if (ch === 'g') {
    overlayGrouped = !overlayGrouped;

    stdout.write(ansi.clear);

    renderOverlay();

    return;
  }

  if (ch === 'p' && sel !== undefined) {
    // A sub-session pins with its parent. Flipped locally too so the
    // repaint is immediate; the daemon's state event confirms it.
    const target =
      (sel.parent === null ? undefined : fleet.find((x) => x.id === sel.parent)) ?? sel;

    target.pinned = !target.pinned;
    void sendQuiet('session.update', { session: target.id, pinned: target.pinned });
    renderOverlay();

    return;
  }

  if (ch === '?') {
    service.send({ type: 'HELP' });

    return;
  }

  if (ch === 'u' && daemonStale) {
    void restartDaemonOnce();

    return;
  }

  if (ch === 'H' && sel !== undefined && sel.kind === 'pty' && sel.alive && sel.canEject) {
    service.send({ type: 'EJECT', sessionID: sel.id });

    return;
  }

  if (ch === 'H') {
    logClientEvent('ignored H on a session that cannot eject');

    return;
  }

  if (ch === 'P' && sel !== undefined && sel.resumable && (sel.kind === 'headless' || !sel.alive)) {
    void adoptSession(sel.id);

    return;
  }

  if (ch === 'r') {
    service.send({ type: 'SPAWN', resume: true });

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

    if (service.getSnapshot().value === 'overlay') {
      renderOverlay();
    }
  } catch {}
}

function applyEjectKey(buf: Buffer) {
  const edit = planTextEdit(buf, ejectInput, { isLeaderKey, moves: false });

  switch (edit.kind) {
    case 'none':
    case 'move': {
      return;
    }
    case 'cancel': {
      service.send({ type: 'OVERLAY' });

      return;
    }
    case 'leader': {
      toBase();

      return;
    }
    case 'submit': {
      ejectInput = edit.value;
      void yankToHeadless(ejectInput.trim());

      return;
    }
    case 'input': {
      ejectInput = edit.value;

      renderEject();
    }
  }
}

const service = createActor(
  buildClientMachine({
    openHome,
    openAttached,
    openOverlay,
    openHelp,
    openPicker,
    openEject,
  }),
);

// A daemon on another protocol is restarted only when the user confirms
// it, and the fleet it hosted is then restored on the new one.
let restartedOnBoot = false;
let daemonWaiting = false;

const reconnectDaemonOnce = makeSingleFlight(async () => {
  daemonWaiting = true;

  service.send({ type: 'OVERLAY' });

  scheduleStatus();

  try {
    const next = await bootDaemonClient({ onWaitForDaemon: scheduleStatus });

    client = next.client;
    daemonStale = next.stale;
    daemonFeatures = next.features;
    lastUsedAgent = next.lastUsedAgent;
    client.onEvent = applyDaemonEvent;
    client.onClose = handleDaemonClose;

    await refreshMirror();
    await refreshAgents();

    renderOverlay();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(message);
  } finally {
    daemonWaiting = false;

    scheduleStatus();
  }
});

function handleDaemonClose() {
  if (!daemonRestarting) {
    void reconnectDaemonOnce();
  }
}

const boot = await bootDaemonClient({
  onProtocolMismatch: async (mismatch) => {
    restartedOnBoot = await waitForRestartConsent(mismatch);

    return restartedOnBoot;
  },
});

let client = boot.client;
let daemonStale = boot.stale;
let daemonFeatures = boot.features;
let daemonRestarting = false;

lastUsedAgent = boot.lastUsedAgent;
client.onEvent = applyDaemonEvent;
client.onClose = handleDaemonClose;

if (restartedOnBoot) {
  await sendQuiet('fleet.restore', { cols: cols(), rows: ptyRows() });
}

await refreshMirror();
await refreshAgents();

/**
 * Asks on the terminal whether to restart a daemon that speaks another
 * protocol, reading a single key. Anything but `y` declines, and so does a
 * terminal that cannot answer.
 */
async function waitForRestartConsent(mismatch: ProtocolMismatch): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  process.stderr.write(
    [
      `atc: the daemon (pid ${mismatch.daemonPID}) speaks another protocol than this client, ${mismatch.clientBuild} on protocol v${mismatch.clientProtocol}.`,
      `The daemon answered: ${mismatch.daemonMessage}`,
      'Restart it now? Every session it hosts ends, then the fleet is restored on the new daemon. [y/N] ',
    ].join('\n'),
  );

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const key = await new Promise<string>((resolve) => {
    process.stdin.once('data', (buf: Buffer) => {
      resolve(buf.toString());
    });
  });

  process.stdin.setRawMode(false);
  process.stdin.pause();

  const confirmed = key === 'y' || key === 'Y';
  const echo = confirmed ? 'y\n' : 'n\n';

  process.stderr.write(echo);

  return confirmed;
}

async function refreshMirror() {
  const list = await client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (Array.isArray(sessions)) {
    fleet = [];

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

/**
 * The deliberate half of the stale-daemon story: quits the old daemon,
 * boots one from the current build, and restores the whole fleet, so an
 * update never interrupts sessions until the user picks the moment. A
 * press while a restart runs joins it rather than starting another, and
 * the status bar says a restart is running until it finishes.
 */
const restartDaemonOnce = makeSingleFlight(async () => {
  daemonRestarting = true;

  renderOverlay();

  try {
    await restartDaemon();
  } finally {
    daemonRestarting = false;

    scheduleStatus();
  }
});

async function restartDaemon() {
  if (readManagedDaemonUnit() === null) {
    try {
      await client.sendRequest('daemon.quit');
    } catch {}
  } else {
    await restartManagedDaemon();
  }

  client.stop();

  const deadline = Date.now() + 8000;

  let next = await bootDaemonClient();

  while (next.stale && Date.now() < deadline) {
    next.client.stop();

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    next = await bootDaemonClient();
  }

  client = next.client;
  daemonStale = next.stale;
  daemonFeatures = next.features;
  lastUsedAgent = next.lastUsedAgent;
  client.onEvent = applyDaemonEvent;
  client.onClose = handleDaemonClose;

  // A new daemon may map aliases differently, so rows fall back to the
  // config baseline until its own answer arrives; the target count goes
  // back to none for the same reason, hiding the column until the new
  // daemon reports what it can spawn on.
  const baseline = resolveAgentMetadata(loadConfig(), {});

  agentLabels = baseline.labels;
  agentModels = baseline.models;
  availableTargets = 0;

  await sendQuiet('fleet.restore', { cols: cols(), rows: ptyRows() });
  await refreshMirror().catch(() => {});
  await refreshAgents();

  service.send({ type: 'OVERLAY' });
}

process.stdin.setRawMode(true);
process.stdin.resume();

// Stateful decode for the stdin -> daemon path: a multi-byte character split
// across two stdin reads must not be mangled by per-chunk toString().
const stdinDecoder = new TextDecoder('utf-8');

process.stdin.on('data', (buf: Buffer) => {
  switch (service.getSnapshot().value) {
    case 'attached': {
      if (isLeaderKey(buf)) {
        service.send({ type: 'OVERLAY' });

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
      if (isLeaderKey(buf)) {
        service.send({ type: 'OVERLAY' });

        return;
      }

      const ch = buf.toString();

      if (ch === 'n') {
        service.send({ type: 'SPAWN', resume: false });

        return;
      }

      if (ch === 'r') {
        service.send({ type: 'SPAWN', resume: true });

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
    case 'picker': {
      picker.applyKey(buf);

      return;
    }
    case 'picker-eject': {
      applyEjectKey(buf);
    }
  }
});

stdout.on('resize', () => {
  const currentMode = service.getSnapshot().value;

  if (currentMode === 'attached' && focusedID !== null) {
    void sendQuiet('session.resize', { session: focusedID, cols: cols(), rows: ptyRows() });
  }

  if (currentMode === 'home') {
    drawHome(fleetCount, leader.label);
  }

  if (currentMode === 'overlay') {
    stdout.write(ansi.clear);

    renderOverlay();
  }

  if (currentMode === 'picker') {
    stdout.write(ansi.clear);
    picker.render();
  }

  if (currentMode === 'picker-eject') {
    stdout.write(ansi.clear);

    renderEject();
  }

  scheduleStatus();
});

process.on('uncaughtException', (err) => {
  stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

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
service.start();
