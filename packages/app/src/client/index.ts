import { configFile, loadConfig } from '@atc/config';
import { resolveHomeDir } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import { ansi, makeSingleFlight, systemClock } from '@atc/core';
import { countSessionStates, sortGroupedSessionViews, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot, DaemonFeature, ProtocolMismatch } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { DaemonClient, EventMsg } from '@atc/protocol/wire';
import { DaemonTransport } from '@atc/protocol/wire/transport';
import { match } from 'ts-pattern';
import { createActor } from 'xstate';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { buildLeaderChords } from './build-leader-chords';
import { collectTargetPicks } from './collect-target-picks';
import { findFuzzyScore, formatDir } from './dirs';
import { KEY, isDown, isUp, planTextEdit } from './keys';
import { openListingCache } from './open-listing-cache';
import { parseDaemonEvent } from './parse-daemon-event';
import { pickPinTarget } from './pick-pin-target';
import { pickTabTarget } from './pick-tab-target';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { SpawnPicker } from './spawn-picker';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import { tuiHostSlot } from './tui-host-slot';
import { cols, drawHelp, drawHome, drawOverlay, drawPicker, drawStatusBar, rows } from './ui';

// The daemon boot, restart, and event log the entry wired in.
const host = tuiHostSlot.current;

if (host === null) {
  throw new Error('the TUI started without a host');
}

const bootDaemonClient = host.bootDaemon;
const restartDaemonAt = host.restartDaemon;
const logClientEvent = host.logEvent;
const remoteDaemonName = host.daemonName;

// The time and the timers every wait of this client runs on.
const clock = systemClock;
let overlaySelected = 0;

// The client's mirror of the daemon's fleet, kept fresh by events.
let fleet: MirrorSession[] = [];

// When each session last flipped to done, so the Tab jump can prefer the
// most recently finished turn. Sessions already done before this client
// connected have no entry and rank last.
const doneAt = new Map<string, number>();

let focusedID: string | null = null;
let fleetCount = 0;
let lastUsedAgent: AgentID = loadConfig(SHIPPED_HARNESS_PLUGINS).defaultAgent;

// The readable harness label and tier-alias map per agent: the config alone
// until the daemon's `agents.list` answer arrives and re-resolves them
// whenever the overlay opens, so a backend configured after this client
// started still lists under its name.
const bootMetadata = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), {});
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

    if (getMode() !== 'attached') {
      const focused = findFocused();
      const urgent = sortSessionViews(fleet).find((s) => s.state === 'needs_you');

      drawStatusBar({
        counts: countSessionStates(fleet),
        focusedName: focused === null ? null : focused.name,
        urgentName: urgent === undefined ? null : urgent.name,
        leaderLabel: leader.label,
        stale: getBoot().stale,
        restarting: isDaemonRestarting(),
        waiting: isDaemonWaiting(),
        daemonName: remoteDaemonName,
      });
    }
  }, 50);
}

async function sendQuiet(m: string, p?: Readonly<Record<string, unknown>>) {
  try {
    await getClient().sendRequest(m, p);
  } catch {}
}

// A kill the daemon refuses because forgetting the session destroys its
// host asks once more before the forget.
async function sendKill(sessionID: string) {
  try {
    await getClient().sendRequest('session.kill', { session: sessionID });
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'confirmation_required') {
      service.send({ type: 'CONFIRM_DESTROY', sessionID });

      if (getMode() === 'overlay') {
        renderOverlay();
      }
    }
  }
}

// Takes the confirm token the daemon offers and hands it straight back:
// the operator already confirmed in the overlay.
async function sendForget(sessionID: string) {
  try {
    const offered = await getClient().sendRequest('session.forget', { session: sessionID });

    const confirmToken = offered['confirmToken'];

    if (typeof confirmToken === 'string') {
      await getClient().sendRequest('session.forget', { session: sessionID, confirmToken });
    }
  } catch {}
}

async function attach(sessionID: string) {
  service.send({ type: 'ATTACH', sessionID });

  try {
    await getClient().sendRequest('session.attach', {
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
    await getClient().sendRequest('session.eject', {
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
    await getClient().sendRequest('session.adopt', { session: id, cols: cols(), rows: ptyRows() });
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

// Draws the overlay with the confirmation the machine holds, or with the one
// given, for a caller that runs before the machine's step settles.
function renderOverlay(confirm: 'none' | 'kill' | 'destroy' = getConfirm()) {
  const sessions = pickOverlaySessions();

  overlaySelected = Math.max(0, Math.min(overlaySelected, sessions.length - 1));

  drawOverlay({
    sessions,
    agentLabels,
    agentModels,
    showTarget: availableTargets >= 2,
    selected: overlaySelected,
    confirmKill: confirm === 'kill',
    confirmDestroy: confirm === 'destroy',
    filter: overlayFilter,
    stale: getBoot().stale && !isDaemonRestarting(),
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
    const answer = await getClient().sendRequest('agents.list');

    const meta = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), answer);

    agentLabels = meta.labels;
    agentModels = meta.models;
    availableTargets = collectTargetPicks(answer).filter((t) => t.available).length;
  } catch {
    return;
  }

  if (getMode() === 'overlay') {
    renderOverlay();
  }
}

// Runs as the overlay opens, inside the machine's step that also drops any
// pending confirmation, so it draws without one.
function openOverlay() {
  overlayFilter = null;
  void refreshAgents();
  const focusedIndex = pickOverlaySessions().findIndex((s) => s.id === focusedID);

  overlaySelected = Math.max(0, focusedIndex);

  stdout.write(ansi.resetInputModes + ansi.clear);

  renderOverlay('none');
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

  // The restart prompt keeps the screen until it has its key.
  write: (chunk) => {
    if (findRestartConsent() === null) {
      process.stdout.write(chunk);
    }
  },
  cwd: process.cwd(),
  home: resolveHomeDir(),
  configPath: configFile,
  onDropAnswer: (kind) => {
    logClientEvent(`dropped ${kind} answer`);
  },
  log: logClientEvent,
  listingCache: openListingCache(host.listingCacheFile),
  getDaemonSocketPath: () => getBoot().socketPath,
  now: clock.now,
});

function openPicker(resume: boolean) {
  picker.open(resume);
}

function hasDaemonFeature(feature: DaemonFeature): boolean {
  return getBoot().features.has(feature);
}

function sendRequest(m: string, p?: Readonly<Record<string, unknown>>) {
  return getClient().sendRequest(m, p);
}

function getLastUsedAgent(): AgentID {
  return lastUsedAgent;
}

async function restoreFleet() {
  try {
    await getClient().sendRequest('fleet.restore', { cols: cols(), rows: ptyRows() });
  } catch {
    return;
  }

  const first = sortSessionViews(fleet).find((s) => s.alive);

  if (first !== undefined) {
    await attach(first.id);
  }
}

function quit(code = 0, message?: string): never {
  detachFocused();

  transport.stop();
  stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  if (message !== undefined) {
    console.error(message);
  }

  process.exit(code);
}

function upsertMirror(d: Readonly<MirrorSession>) {
  const existing = fleet.find((s) => s.id === d.id);

  if (existing === undefined) {
    fleet.push({ ...d });
  } else {
    existing.name = d.name;
    existing.pinned = d.pinned;
    existing.parent = d.parent;
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
  const currentMode = getMode();

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
      if (getMode() === 'attached' && e.s === focusedID) {
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
          doneAt.set(e.session.id, clock.now());
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

const leader = loadConfig(SHIPPED_HARNESS_PLUGINS).leader;
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
  const confirm = getConfirm();

  if (confirm === 'kill') {
    if (buf[0] === KEY.y && sel !== undefined) {
      void sendKill(sel.id);
    }

    service.send({ type: 'CONFIRM_DONE' });

    renderOverlay();

    return;
  }

  const destroyID = service.getSnapshot().context.destroyID;

  if (confirm === 'destroy' && destroyID !== null) {
    if (buf[0] === KEY.y) {
      void sendForget(destroyID);
    }

    service.send({ type: 'CONFIRM_DONE' });

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
    // Flipped locally too so the repaint is immediate; the daemon's state
    // event confirms it.
    const target = pickPinTarget(sel, fleet);

    target.pinned = !target.pinned;
    void sendQuiet('session.update', { session: target.id, pinned: target.pinned });
    renderOverlay();

    return;
  }

  if (ch === '?') {
    service.send({ type: 'HELP' });

    return;
  }

  if (ch === 'u' && getBoot().stale) {
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
    service.send({ type: 'CONFIRM_KILL' });

    renderOverlay();

    return;
  }

  if (ch === 'q' || buf[0] === KEY.ctrlC) {
    quit();
  }
}

async function yankResume(sessionID: string, eject: boolean) {
  try {
    const answer = await getClient().sendRequest('session.resumeCommand', { session: sessionID });

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

    if (getMode() === 'overlay') {
      renderOverlay();
    }
  } catch (error) {
    // A session the daemon cannot resume outside atc keeps running, and
    // the reason replaces the copy notice.
    recordActionFailure(sessionID, error);

    if (getMode() === 'overlay') {
      renderOverlay();
    }
  }
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

// The screen the client shows, as the machine's mode region holds it.
function getMode() {
  return service.getSnapshot().value.mode;
}

// The confirmation the overlay waits on: none, a kill, or a forget that
// destroys the session's host.
function getConfirm() {
  return service.getSnapshot().value.confirm;
}

// The restart prompt that waits for its key, or null.
function findRestartConsent(): RestartConsent | null {
  return service.getSnapshot().context.consent;
}

// What one open of the daemon gave the client: its boot, and whether the
// user restarted a daemon on another protocol to get it, so the fleet that
// daemon hosted is restored on the new one.
interface DaemonLink {
  readonly boot: DaemonBoot;
  readonly restarted: boolean;
}

/**
 * The connection to the daemon, which reconnects as soon as it is lost. The
 * first open is the client's boot, and its failure ends the client before
 * the first frame. A later open waits for the daemon the way the boot does;
 * a daemon on another protocol that the user keeps in service cannot serve
 * this client, and a remote boot waits out an unreachable daemon itself, so
 * either failure ends the client. Any other failure is logged and the next
 * open follows a backoff.
 */
const transport: DaemonTransport<DaemonLink> = new DaemonTransport<DaemonLink>({
  reconnect: 'always',
  backoffMs: [0, 200, 1000, 2000],
  clock,
  getChannel: (link) => link.boot.client,
  open: (opened) => {
    const phase = opened === 0 ? 'boot' : 'tui';

    return openDaemonLink(phase);
  },
  isFatal: (error) =>
    transport.findLatest() === null ||
    (error instanceof DaemonError && error.code === 'protocol_mismatch') ||
    remoteDaemonName !== null,
  onReady: (link) => {
    lastUsedAgent = link.boot.lastUsedAgent;
    link.boot.client.onEvent = applyDaemonEvent;

    service.send({ type: 'DAEMON_READY' });

    scheduleStatus();
  },
  onLost: () => {
    // The reconnect leaves the picker, so no answer its flow still waits on
    // draws it again. A deliberate restart keeps the screen it drew.
    service.send({ type: 'DAEMON_LOST' });

    if (!isDaemonRestarting()) {
      picker.stopFlow();
      service.send({ type: 'OVERLAY' });
    }

    scheduleStatus();
  },
  onOpenFailed: (error, fatal) => {
    const message = error instanceof Error ? error.message : String(error);

    if (fatal && transport.findLatest() !== null) {
      quit(1, `atc: ${message}`);
    }

    if (!isDaemonRestarting()) {
      logClientEvent(`reconnect: ${message}; trying again`);
    }

    scheduleStatus();
  },
});

// Opens and handshakes the daemon. A daemon on another protocol is
// restarted only when the user confirms it: on the first open the prompt
// goes to stderr, and once the TUI owns the screen it replaces the screen.
async function openDaemonLink(phase: 'boot' | 'tui'): Promise<DaemonLink> {
  let restarted = false;

  const boot = await bootDaemonClient({
    clock,
    ...(phase === 'tui' ? { onWaitForDaemon: scheduleStatus } : {}),
    onProtocolMismatch: async (mismatch) => {
      restarted = await waitForRestartConsent(mismatch, phase);

      return restarted;
    },
  });

  // A stale answer means the old daemon still holds the socket, so the
  // open is refused and the next one boots again.
  if (boot.stale && clock.now() < service.getSnapshot().context.freshUntil) {
    boot.client.stop();
    throw new Error('the old daemon still answers');
  }

  if (phase === 'tui') {
    void refreshAfterReconnect(restarted, () => boot.client.isClosed());
  }

  return { boot, restarted };
}

// Brings the mirror up to date on a daemon the client reconnected to. A
// connection lost on the way is left to the next reconnect, which runs
// this again.
async function refreshAfterReconnect(restarted: boolean, isClosed: () => boolean) {
  await transport.waitForConnection();

  try {
    if (restarted) {
      await sendQuiet('fleet.restore', { cols: cols(), rows: ptyRows() });
    }

    await refreshMirror();
    await refreshAgents();
  } catch (error) {
    if (!isClosed()) {
      logClientEvent(`reconnect: ${error instanceof Error ? error.message : String(error)}`);
    }

    return;
  }

  if (getMode() === 'overlay') {
    renderOverlay();
  }
}

// A boot that fails leaves before the first frame, with its message alone:
// the message holds the daemon and what to do, and a stack would bury it.
const firstLink = await transport.waitForConnection().catch((error: unknown) => {
  stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  console.error(`atc: ${error instanceof Error ? error.message : String(error)}`);

  return process.exit(1);
});

if (firstLink.restarted) {
  await sendQuiet('fleet.restore', { cols: cols(), rows: ptyRows() });
}

await refreshMirror();
await refreshAgents();

// The client of the latest connection. A request on one that was lost
// rejects at once, as the reconnect takes its place.
function getClient(): DaemonClient {
  const link = transport.findLatest();

  if (link === null) {
    throw new Error('the client has no daemon connection yet');
  }

  return link.boot.client;
}

// The boot of the latest connection: the daemon's socket, which a restart
// takes it out of service by, its build, and its features.
function getBoot(): DaemonBoot {
  const link = transport.findLatest();

  if (link === null) {
    throw new Error('the client has no daemon connection yet');
  }

  return link.boot;
}

// Where the client stands with the daemon, as the machine holds it.
function isDaemonWaiting(): boolean {
  return service.getSnapshot().matches({ daemon: 'waiting' });
}

function isDaemonRestarting(): boolean {
  return service.getSnapshot().matches({ daemon: 'restarting' });
}

/**
 * Asks on the terminal whether to restart a daemon that speaks another
 * protocol, reading a single key. Anything but `y` declines, and so does a
 * terminal that cannot answer. On the first boot the prompt goes to stderr
 * and the key comes straight from stdin; once the TUI owns the screen and
 * stdin, the prompt replaces the screen and the TUI's own reader passes
 * the key on.
 */
async function waitForRestartConsent(
  mismatch: ProtocolMismatch,
  phase: 'boot' | 'tui',
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const lines = [
    `atc: the daemon (pid ${mismatch.daemonPID}) speaks another protocol than this client, ${mismatch.clientBuild} on protocol v${mismatch.clientProtocol}.`,
    `The daemon answered: ${mismatch.daemonMessage}`,
    'Restart it now? Every session it hosts ends, then the fleet is restored on the new daemon. [y/N] ',
  ];

  if (phase === 'tui') {
    const prompt = lines.join('\r\n');

    stdout.write(ansi.clear + prompt);

    const key = await new Promise<string>((resolve) => {
      service.send({ type: 'CONSENT_ASKED', consent: { prompt, answer: resolve } });
    });

    // The mode under the prompt may have changed while the reconnect
    // waited, so the screen it owns is drawn again rather than left blank.
    stdout.write(ansi.clear);

    drawMode();

    return key === 'y' || key === 'Y';
  }

  process.stderr.write(lines.join('\n'));
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
  const list = await getClient().sendRequest('session.list');

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

  const answer = await getClient()
    .sendRequest('fleet.list')
    .catch(() => ({}) as const);

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
  service.send({ type: 'RESTART_STARTED' });

  renderOverlay();

  try {
    await restartDaemon();
  } finally {
    service.send({ type: 'RESTART_ENDED', connected: transport.readState() === 'ready' });

    scheduleStatus();
  }
});

async function restartDaemon() {
  // The step `atc daemon restart` takes: the user service that runs the
  // daemon restarts, or the daemon stops. A daemon that cannot be found or
  // restarted stays in service, and the client stays on it.
  const socketPath = getBoot().socketPath;
  let restarted: boolean;

  try {
    restarted = await restartDaemonAt(socketPath);
  } catch (error) {
    logClientEvent(
      `restart: ${error instanceof Error ? error.message : String(error)}; the daemon was left running`,
    );

    return;
  }

  if (!restarted) {
    logClientEvent(`restart: no pid found for the daemon at ${socketPath}; it was left running`);

    return;
  }

  // A new daemon may map aliases differently, so rows fall back to the
  // config baseline until its own answer arrives; the target count goes
  // back to none for the same reason, hiding the column until the new
  // daemon reports what it can spawn on.
  const baseline = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), {});

  agentLabels = baseline.labels;
  agentModels = baseline.models;
  availableTargets = 0;

  // The transport reconnects once the old connection is dropped, and
  // refuses the old daemon while it still answers.
  service.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: clock.now() + 8000 });

  const old = transport.findLatest();

  if (old !== null) {
    transport.stopConnection(old);
  }

  // A new daemon that has not answered by the deadline shows as a wait like
  // any other, with each failed open logged; the restore still runs once
  // it answers.
  const cancelLate = clock.schedule(() => {
    service.send({ type: 'RESTART_ENDED', connected: false });

    logClientEvent('restart: the new daemon has not answered in 8s; still trying');
    scheduleStatus();
  }, 8000);

  await transport.waitForConnection();

  cancelLate();

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
  const pending = findRestartConsent();

  if (pending !== null) {
    service.send({ type: 'CONSENT_ANSWERED' });
    pending.answer(buf.toString());

    return;
  }

  switch (getMode()) {
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
  // The restart prompt keeps the screen until it has its key, so a resize
  // draws it again rather than the mode under it.
  const consent = findRestartConsent();

  if (consent !== null) {
    stdout.write(ansi.clear + consent.prompt);

    return;
  }

  if (getMode() === 'attached' && focusedID !== null) {
    void sendQuiet('session.resize', { session: focusedID, cols: cols(), rows: ptyRows() });
  }

  drawMode();
});

/**
 * Draws the current mode's screen again after something else held the
 * terminal. An attached session repaints only through the agent, so it is
 * left to the resize the daemon passes on.
 */
function drawMode() {
  switch (getMode()) {
    case 'home': {
      drawHome(fleetCount, leader.label);
      break;
    }
    case 'overlay': {
      stdout.write(ansi.clear);

      renderOverlay();
      break;
    }
    case 'help': {
      openHelp();
      break;
    }
    case 'picker': {
      stdout.write(ansi.clear);
      picker.render();
      break;
    }
    case 'picker-eject': {
      stdout.write(ansi.clear);

      renderEject();
      break;
    }
    case 'attached': {
      break;
    }
  }

  scheduleStatus();
}

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
