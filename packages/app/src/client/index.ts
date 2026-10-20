import { configFile, loadConfig } from '@atc/config';
import { resolveHomeDir } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import { ansi, makeSingleFlight, systemClock } from '@atc/core';
import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import { createActor } from 'xstate';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { applyDaemonEvent } from './apply-daemon-event';
import type { DaemonEventDeps } from './apply-daemon-event';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { buildLeaderChords } from './build-leader-chords';
import { DaemonConnection } from './daemon-connection';
import { EjectScreen } from './eject-screen';
import { FleetMirror } from './fleet-mirror';
import { openListingCache } from './open-listing-cache';
import { OverlayScreen } from './overlay-screen';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { restartDaemon } from './restart-daemon';
import { SessionActions } from './session-actions';
import { SpawnPicker } from './spawn-picker';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import { tuiHostSlot } from './tui-host-slot';
import { cols, drawHelp, drawHome, drawStatusBar, rows } from './ui';

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

const mirror = new FleetMirror();

let focusedID: string | null = null;
let lastUsedAgent: AgentID = loadConfig(SHIPPED_HARNESS_PLUGINS).defaultAgent;

// the config alone until the daemon's `agents.list` answer arrives; it re-resolves on
// every overlay open, so a backend configured after this client started still lists
// under its name.
const bootMetadata = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), {});
const stdout = process.stdout;

// Full height: the atc status bar only exists on home/overlay screens;
// attached sessions render fleet state via their own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}

function findFocused(): MirrorSession | null {
  return mirror.sessions.find((session) => session.id === focusedID) ?? null;
}

function openHome() {
  drawHome(mirror.count, leader.label);
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

      const urgent = sortSessionViews(mirror.sessions).find(
        (session) => session.state === 'needs_you',
      );

      drawStatusBar({
        counts: countSessionStates(mirror.sessions),
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

async function sendQuiet(method: string, params?: Readonly<Record<string, unknown>>) {
  try {
    await getClient().sendRequest(method, params);
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

function showBase() {
  const focused = findFocused();

  if (focused !== null && focused.alive) {
    service.send({ type: 'ATTACH', sessionID: focused.id });
    void sendQuiet('session.attach', { session: focused.id, cols: cols(), rows: ptyRows() });
  } else {
    service.send({ type: 'HOME' });
  }
}

function openHelp() {
  stdout.write(ansi.clear);

  drawHelp();
}

const picker = new SpawnPicker<MirrorSession>({
  sendRequest,
  ptyRows,
  isLeaderKey,
  getLastUsedAgent,
  scheduleStatus,
  showBase,
  attach,
  toMirrorSession,
  upsertMirror: (session) => {
    mirror.upsert(session);
  },

  // The restart prompt keeps the screen until it has its key.
  write: (chunk) => {
    if (findRestartConsent() === null) {
      process.stdout.write(chunk);
    }
  },
  cwd: process.cwd(),
  home: resolveHomeDir(),
  remoteDaemon: remoteDaemonName !== null,
  configPath: configFile,
  onDropAnswer: (kind) => {
    logClientEvent(`dropped ${kind} answer`);
  },
  log: logClientEvent,
  listingCache: openListingCache(host.listingCacheFile),
  getDaemonSocketPath: () => getBoot().socketPath,
  clock,
});

function openPicker(resume: boolean) {
  picker.open(resume);
}

function sendRequest(method: string, params?: Readonly<Record<string, unknown>>) {
  return getClient().sendRequest(method, params);
}

function getLastUsedAgent(): AgentID {
  return lastUsedAgent;
}

function setLastUsedAgent(agent: AgentID) {
  lastUsedAgent = agent;
}

function findFocusedID(): string | null {
  return focusedID;
}

async function restoreFleet() {
  try {
    await getClient().sendRequest('fleet.restore', { cols: cols(), rows: ptyRows() });
  } catch {
    return;
  }

  const first = sortSessionViews(mirror.sessions).find((session) => session.alive);

  if (first !== undefined) {
    await attach(first.id);
  }
}

function quit(code = 0, message?: string): never {
  detachFocused();

  connection.transport.stop();
  stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  if (message !== undefined) {
    console.error(message);
  }

  process.exit(code);
}

// ---- input ----

const leader = loadConfig(SHIPPED_HARNESS_PLUGINS).leader;
const leaderChords = buildLeaderChords(leader.code);

// A fullscreen session can leave the terminal in an enhanced keyboard
// encoding, so the leader arrives as a CSI chord instead of its bare byte.
function isLeaderKey(buf: Buffer): boolean {
  return leaderChords.includes(buf.toString());
}

const service = createActor(
  buildClientMachine({
    openHome,
    openAttached,
    openOverlay: () => {
      overlay.open();
    },
    openHelp,
    openPicker,
    openEject: (sessionID) => {
      eject.open(sessionID);
    },
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

const overlay = new OverlayScreen({
  mirror,
  bootMetadata,
  findFocusedID,
  getMode,
  getConfirm,
  getClient,
  getBoot,
  isDaemonRestarting,
  scheduleStatus,
});

const actions = new SessionActions({
  service,
  mirror,
  overlay,
  getClient,
  getMode,
  attach,
  sendQuiet,
  ptyRows,
});

const eject = new EjectScreen({
  service,
  actions,
  getClient,
  isLeaderKey,
  showBase,
  scheduleStatus,
});

const eventDeps: DaemonEventDeps = {
  service,
  mirror,
  overlay,
  clock,
  getMode,
  findFocusedID,
  setFocusedID: (sessionID) => {
    focusedID = sessionID;
  },
  setLastUsedAgent,
  findFocused,
  scheduleStatus,
};

const connection = new DaemonConnection({
  clock,
  bootDaemonClient,
  remoteDaemonName,
  service,
  mirror,
  overlay,
  picker,
  getMode,
  isDaemonRestarting,
  scheduleStatus,
  drawMode,
  sendQuiet,
  ptyRows,
  quit,
  logClientEvent,
  onEvent: (raw) => {
    applyDaemonEvent(raw, eventDeps);
  },
  setLastUsedAgent,
});

// A boot that fails leaves before the first frame, with its message alone:
// the message holds the daemon and what to do, and a stack would bury it.
const firstLink = await connection.transport.waitForConnection().catch((error: unknown) => {
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

await mirror.refresh(getClient);
await overlay.refreshAgents();

function getClient(): DaemonClient {
  return connection.getClient();
}

function getBoot(): DaemonBoot {
  return connection.getBoot();
}

// Where the client stands with the daemon, as the machine holds it.
function isDaemonWaiting(): boolean {
  return service.getSnapshot().matches({ daemon: 'waiting' });
}

function isDaemonRestarting(): boolean {
  return service.getSnapshot().matches({ daemon: 'restarting' });
}

const restartDaemonOnce = makeSingleFlight(async () => {
  service.send({ type: 'RESTART_STARTED' });
  overlay.render();

  try {
    await restartDaemon({
      service,
      mirror,
      overlay,
      transport: connection.transport,
      clock,
      getBoot,
      getClient,
      restartDaemonAt,
      sendQuiet,
      logClientEvent,
      scheduleStatus,
      ptyRows,
    });
  } finally {
    service.send({
      type: 'RESTART_ENDED',
      connected: connection.transport.readState() === 'ready',
    });

    scheduleStatus();
  }
});

process.stdin.setRawMode(true);
process.stdin.resume();

// Stateful decode for the stdin -> daemon path: a multi-byte character split
// across two stdin reads must not be mangled by per-chunk toString().
const stdinDecoder = new TextDecoder('utf-8');

const inputDeps: InputKeyDeps = {
  service,
  mirror,
  overlay,
  actions,
  picker,
  eject,
  stdinDecoder,
  getMode,
  getConfirm,
  getBoot,
  findFocusedID,
  findRestartConsent,
  isLeaderKey,
  showBase,
  attach,
  sendQuiet,
  restoreFleet,
  restartDaemonOnce,
  logClientEvent,
  quit,
};

process.stdin.on('data', (buf: Buffer) => {
  applyInputKey(buf, inputDeps);
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

function drawMode() {
  switch (getMode()) {
    case 'home': {
      drawHome(mirror.count, leader.label);
      break;
    }
    case 'overlay': {
      stdout.write(ansi.clear);
      overlay.render();
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
      eject.render();
      break;
    }
    case 'attached': {
      // a session repaints only through the agent, on the resize the daemon passes on.
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
