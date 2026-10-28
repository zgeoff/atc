import type { AgentID } from '@atc/core';
import { ansi, makeSingleFlight, systemClock } from '@atc/core';
import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import { resolveHomeDir } from '@atcx/contract/light';
import { match } from 'ts-pattern';
import { createActor } from 'xstate';
import { applyDaemonEvent } from './apply-daemon-event';
import type { DaemonEventDeps } from './apply-daemon-event';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { buildLeaderChords } from './build-leader-chords';
import { createEjectScreen } from './create-eject-screen';
import { createFleetMirror } from './create-fleet-mirror';
import { createOverlayScreen } from './create-overlay-screen';
import { createSessionActions } from './create-session-actions';
import { createTUIDaemonConnection } from './create-tui-daemon-connection';
import { createSpawnPicker } from './picker/create-spawn-picker';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { restartDaemon } from './restart-daemon';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import type { TUIHost } from './tui-host';
import { cols, drawHelp, drawHome, drawStatusBar, rows } from './ui';

export async function runTUI(host: TUIHost): Promise<void> {
  const bootDaemonClient = host.bootDaemon;
  const restartDaemonAt = host.restartDaemon;
  const logClientEvent = host.logEvent;
  const remoteDaemonName = host.daemonName;

  // The time and the timers every wait of this client runs on.
  const clock = systemClock;
  const mirror = createFleetMirror();
  let focusedID: string | null = null;
  let lastUsedAgent: AgentID = host.readConfig().defaultAgent;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  // the config alone until the daemon's `agents.list` answer arrives; it re-resolves on
  // every overlay open, so a backend configured after this client started still lists
  // under its name.
  const bootMetadata = resolveAgentMetadata(host.readConfig(), {});
  const stdout = process.stdout;
  const leader = host.readConfig().leader;
  const leaderChords = buildLeaderChords(leader.code);

  const findFocused = (): MirrorSession | null =>
    mirror.sessions.find((session) => session.id === focusedID) ?? null;

  const openHome = () => {
    drawHome(mirror.count, leader.label);
    scheduleStatus();
  };

  const openAttached = (sessionID: string) => {
    focusedID = sessionID;

    stdout.write(ansi.clear + ansi.showCursor);

    scheduleStatus();
  };

  const scheduleStatus = () => {
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
  };

  const sendQuiet = async (method: string, params?: Readonly<Record<string, unknown>>) => {
    try {
      await getClient().sendRequest(method, params);
    } catch {}
  };

  const attach = async (sessionID: string) => {
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
  };

  const detachFocused = () => {
    if (focusedID !== null) {
      void sendQuiet('session.detach', { session: focusedID });
    }
  };

  const showBase = () => {
    const focused = findFocused();

    if (focused !== null && focused.alive) {
      service.send({ type: 'ATTACH', sessionID: focused.id });
      void sendQuiet('session.attach', { session: focused.id, cols: cols(), rows: ptyRows() });
    } else {
      service.send({ type: 'HOME' });
    }
  };

  const openHelp = () => {
    stdout.write(ansi.clear);

    drawHelp();
  };

  const openPicker = (resume: boolean) => {
    picker.open(resume);
  };

  const sendRequest = (method: string, params?: Readonly<Record<string, unknown>>) =>
    getClient().sendRequest(method, params);

  const getLastUsedAgent = (): AgentID => lastUsedAgent;

  const setLastUsedAgent = (agent: AgentID) => {
    lastUsedAgent = agent;
  };

  const findFocusedID = (): string | null => focusedID;

  const restoreFleet = async () => {
    try {
      await getClient().sendRequest('fleet.restore', { cols: cols(), rows: ptyRows() });
    } catch {
      return;
    }

    const first = sortSessionViews(mirror.sessions).find((session) => session.alive);

    if (first !== undefined) {
      await attach(first.id);
    }
  };

  const quit = (code = 0, message?: string): never => {
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
  };

  // A fullscreen session can leave the terminal in an enhanced keyboard
  // encoding, so the leader arrives as a CSI chord instead of its bare byte.
  const isLeaderKey = (buf: Buffer): boolean => leaderChords.includes(buf.toString());

  // The screen the client shows, as the machine's mode region holds it.
  const getMode = () => service.getSnapshot().value.mode;

  // The confirmation the overlay waits on: none, a kill, or a forget that
  // destroys the session's host.
  const getConfirm = () => service.getSnapshot().value.confirm;

  // The restart prompt that waits for its key, or null.
  const findRestartConsent = (): RestartConsent | null => service.getSnapshot().context.consent;
  const getClient = (): DaemonClient => connection.getClient();
  const getBoot = (): DaemonBoot => connection.getBoot();

  // Where the client stands with the daemon, as the machine holds it.
  const isDaemonWaiting = (): boolean => service.getSnapshot().matches({ daemon: 'waiting' });
  const isDaemonRestarting = (): boolean => service.getSnapshot().matches({ daemon: 'restarting' });

  const drawMode = () => {
    match(getMode())
      .with('home', () => {
        drawHome(mirror.count, leader.label);
      })
      .with('overlay', () => {
        stdout.write(ansi.clear);
        overlay.render();
      })
      .with('help', () => {
        openHelp();
      })
      .with('picker', () => {
        stdout.write(ansi.clear);
        picker.render();
      })
      .with('picker-eject', () => {
        stdout.write(ansi.clear);
        eject.render();
      })
      .with('attached', () => {
        // a session repaints only through the agent, on the resize the daemon passes on.
      })
      .exhaustive();

    scheduleStatus();
  };

  const picker = createSpawnPicker<MirrorSession>({
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
    readConfig: host.readConfig,
    onDropAnswer: (kind) => {
      logClientEvent(`dropped ${kind} answer`);
    },
    log: logClientEvent,
    listingCache: host.listingCache,
    getDaemonSocketPath: () => getBoot().socketPath,
    clock,
  });

  const service = createActor(
    buildClientMachine({
      openHome,
      openAttached,
      closeAttached: detachFocused,
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

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata,
    readConfig: host.readConfig,
    findFocusedID,
    getMode,
    getConfirm,
    getClient,
    getBoot,
    isDaemonRestarting,
    scheduleStatus,
  });

  const actions = createSessionActions({
    service,
    mirror,
    overlay,
    getClient,
    getMode,
    attach,
    sendQuiet,
    ptyRows,
  });

  const eject = createEjectScreen({
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

  const connection = createTUIDaemonConnection({
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
        readConfig: host.readConfig,
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
  stdout.write(ansi.altScreenOn);
  service.start();
}

// Full height: the atc status bar only exists on home/overlay screens;
// attached sessions render fleet state via their own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}
