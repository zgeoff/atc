import type { AgentID } from '@atc/core';
import { ansi, makeSingleFlight, systemClock } from '@atc/core';
import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonEvent } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { createActor } from 'xstate';
import { applyDaemonEvent } from './apply-daemon-event';
import type { DaemonEventDeps } from './apply-daemon-event';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { buildLeaderChords } from './build-leader-chords';
import { createDaemonLinks } from './create-daemon-links';
import { createEjectScreen } from './create-eject-screen';
import { createFleetMirror } from './create-fleet-mirror';
import { createOverlayScreen } from './create-overlay-screen';
import { createSessionActions } from './create-session-actions';
import { createTUIDaemonConnection } from './create-tui-daemon-connection';
import { formatLinkState } from './daemon-link-state';
import { createSpawnPicker } from './picker/create-spawn-picker';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { restartDaemon } from './restart-daemon';
import { formatDaemonFailure, sendToDaemon } from './send-to-daemon';
import { toSessionKey } from './session-key';
import type { DaemonName, SessionKey } from './session-key';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import type { TUIHost } from './tui-host';
import { cols, drawHelp, drawHome, drawStatusBar, rows } from './ui';

// How long the status bar keeps the reason an action sent nothing or was refused.
const STATUS_NOTICE_MS = 8000;

export async function runTUI(host: TUIHost): Promise<void> {
  const [primary] = host.daemons;

  invariant(primary !== undefined, 'the host passes the client at least its primary daemon');

  const primaryName: DaemonName = primary.name;
  const bootDaemonClient = primary.bootDaemon;

  // Only the local daemon can be restarted from here; a daemon on another host restarts there.
  const restartDaemonAt =
    primary.name === null
      ? primary.restartDaemon
      : (): Promise<boolean> =>
          Promise.reject(
            new Error(`daemon '${primary.name}' runs on another host; restart it on that host`),
          );

  const logClientEvent = host.logEvent;

  // The time and the timers every wait of this client runs on.
  const clock = systemClock;
  const mirror = createFleetMirror(primaryName);
  let focusedKey: SessionKey | null = null;
  let lastUsedAgent: AgentID = host.readConfig().defaultAgent;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  // Why the last action on a daemon sent nothing or was refused, until it times out.
  let statusNotice: string | null = null;
  let cancelStatusNotice: (() => void) | null = null;

  // A notice drawn over an attached session stays on the bar's row until the bar draws again.
  let isNoticeOverAttached = false;

  // the config alone until the daemon's `agents.list` answer arrives; it re-resolves on
  // every overlay open, so a backend configured after this client started still lists
  // under its name.
  const bootMetadata = resolveAgentMetadata(host.readConfig(), {});
  const stdout = process.stdout;
  const leader = host.readConfig().leader;
  const leaderChords = buildLeaderChords(leader.code);

  const findFocused = (): MirrorSession | null =>
    focusedKey === null ? null : (mirror.find(toSessionKey(focusedKey)) ?? null);

  const openHome = () => {
    drawHome(mirror.count, leader.label);
    scheduleStatus();
  };

  const openAttached = (key: SessionKey) => {
    focusedKey = key;

    stdout.write(ansi.clear + ansi.showCursor);

    scheduleStatus();
  };

  const scheduleStatus = () => {
    if (statusTimer !== null) {
      return;
    }

    statusTimer = setTimeout(() => {
      statusTimer = null;

      const isOverAttached = getMode() === 'attached' && !isAttachedLinkDown();

      if (!isOverAttached || statusNotice !== null || isNoticeOverAttached) {
        isNoticeOverAttached = isOverAttached && statusNotice !== null;

        const focused = findFocused();
        const visible = overlay.listVisible();
        const urgent = sortSessionViews(visible).find((session) => session.state === 'needs_you');

        drawStatusBar({
          counts: countSessionStates(visible),
          focusedName: focused === null ? null : focused.name,
          urgentName: urgent === undefined ? null : urgent.name,
          leaderLabel: leader.label,
          stale: getBoot().stale,
          restarting: isDaemonRestarting(),
          waiting: isDaemonWaiting() || isAttachedLinkDown(),
          daemonName: primaryName,
          notice: statusNotice,
        });
      }
    }, 50);
  };

  // The attached session's daemon is a remote one whose link is not up: the session waits for it
  // on its own screen and comes back once the link does.
  const isAttachedLinkDown = (): boolean =>
    getMode() === 'attached' &&
    focusedKey !== null &&
    focusedKey.daemon !== primaryName &&
    links.stateOf(focusedKey.daemon).kind !== 'up';

  const showStatusNotice = (text: string) => {
    statusNotice = text;
    cancelStatusNotice?.();

    cancelStatusNotice = clock.schedule(() => {
      statusNotice = null;
      cancelStatusNotice = null;

      scheduleStatus();
    }, STATUS_NOTICE_MS);

    scheduleStatus();
  };

  const reportFailure = (daemon: DaemonName, error: unknown) => {
    const text = formatDaemonFailure(daemon, error);

    if (text !== null) {
      showStatusNotice(text);
    }
  };

  const sendQuiet = async (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => {
    try {
      await sendToDaemon(links, daemon, method, params);
    } catch {}
  };

  // A refusal of typed input shows on the status bar, so a keystroke is never dropped without a
  // word.
  const sendInput = async (key: SessionKey, data: string) => {
    try {
      await sendToDaemon(links, key.daemon, 'session.input', { session: key.id, data });
    } catch (error) {
      reportFailure(key.daemon, error);
    }
  };

  const attach = async (key: SessionKey) => {
    // A daemon whose link is not up gets nothing, and says why on the status bar.
    if (links.clientFor(key.daemon) === null) {
      showStatusNotice(formatLinkState(key.daemon, links.stateOf(key.daemon)));

      return;
    }

    service.send({ type: 'ATTACH', key });

    try {
      await sendToDaemon(links, key.daemon, 'session.attach', {
        session: key.id,
        cols: cols(),
        rows: ptyRows(),
      });
    } catch (error) {
      reportFailure(key.daemon, error);

      service.send({ type: 'OVERLAY' });
    }
  };

  const detachFocused = () => {
    if (focusedKey !== null) {
      void sendQuiet(focusedKey.daemon, 'session.detach', { session: focusedKey.id });
    }
  };

  const showBase = () => {
    const focused = findFocused();

    if (focused !== null && focused.alive) {
      service.send({ type: 'ATTACH', key: { daemon: focused.daemon, id: focused.id } });

      void sendQuiet(focused.daemon, 'session.attach', {
        session: focused.id,
        cols: cols(),
        rows: ptyRows(),
      });
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

  // The picker spawns on the primary daemon.
  const sendRequest = (method: string, params?: Readonly<Record<string, unknown>>) =>
    sendToDaemon(links, primaryName, method, params);

  const getLastUsedAgent = (): AgentID => lastUsedAgent;

  const setLastUsedAgent = (agent: AgentID) => {
    lastUsedAgent = agent;
  };

  const findFocusedKey = (): SessionKey | null => focusedKey;

  const restoreFleet = async () => {
    try {
      await sendToDaemon(links, primaryName, 'fleet.restore', { cols: cols(), rows: ptyRows() });
    } catch {
      return;
    }

    const first = sortSessionViews(
      mirror.sessions.filter((session) => session.daemon === primaryName),
    ).find((session) => session.alive);

    if (first !== undefined) {
      await attach({ daemon: primaryName, id: first.id });
    }
  };

  const quit = (code = 0, message?: string): never => {
    detachFocused();

    links.stop();
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
  const getBoot = (): DaemonBoot => connection.getBoot();

  // Where the client stands with the daemon, as the machine holds it.
  const isDaemonWaiting = (): boolean => service.getSnapshot().matches({ daemon: 'waiting' });
  const isDaemonRestarting = (): boolean => service.getSnapshot().matches({ daemon: 'restarting' });

  // A confirmation or the eject prompt holds the key of the session it opened on, and ends once
  // that session leaves the list or its daemon's link leaves up.
  const isStale = (key: SessionKey): boolean =>
    !mirror.has(toSessionKey(key)) || links.stateOf(key.daemon).kind !== 'up';

  const cancelStaleConfirmations = () => {
    const confirmKey = service.getSnapshot().context.confirmKey;

    if (confirmKey !== null && getConfirm() !== 'none' && isStale(confirmKey)) {
      service.send({ type: 'CONFIRM_DONE' });

      if (getMode() === 'overlay') {
        overlay.render();
      }
    }

    const ejectKey = eject.findTarget();

    if (getMode() === 'picker-eject' && ejectKey !== null && isStale(ejectKey)) {
      service.send({ type: 'OVERLAY' });
    }
  };

  // A remote link that came back reattaches the session on screen when its refreshed list still
  // holds it, and otherwise returns to the list.
  const resumeAttachedSession = (daemon: DaemonName) => {
    if (getMode() !== 'attached' || focusedKey === null || focusedKey.daemon !== daemon) {
      return;
    }

    if (links.stateOf(daemon).kind !== 'up') {
      return;
    }

    const focused = findFocused();

    if (focused === null || !focused.alive) {
      service.send({ type: 'OVERLAY' });

      return;
    }

    stdout.write(ansi.clear);

    void sendQuiet(daemon, 'session.attach', {
      session: focused.id,
      cols: cols(),
      rows: ptyRows(),
    });
  };

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

  const links = createDaemonLinks({
    daemons: host.daemons,
    clock,
    mirror,
    onEvent: (daemon, event) => {
      handleDaemonEvent(daemon, event);
    },
    readAgents: (daemon, client) => overlay.readAgents(daemon, client),
    logEvent: logClientEvent,
  });

  const picker = createSpawnPicker<MirrorSession>({
    sendRequest,
    ptyRows,
    isLeaderKey,
    getLastUsedAgent,
    scheduleStatus,
    showBase,
    attach: (id) => attach({ daemon: primaryName, id }),
    toMirrorSession: (value) => toMirrorSession(value, primaryName),
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
    remoteDaemon: primaryName !== null,
    readConfig: host.readConfig,
    onDropAnswer: (kind) => {
      logClientEvent(`dropped ${kind} answer`);
    },
    log: logClientEvent,
    listingCache: primary.listingCache,
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
      openEject: (key) => {
        eject.open(key);
      },
    }),
  );

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata,
    readConfig: host.readConfig,
    links,
    findFocusedKey,
    getMode,
    getConfirm,
    findConfirmKey: () => service.getSnapshot().context.confirmKey,
    isBootStale: () => getBoot().stale,
    isDaemonRestarting,
    scheduleStatus,
    write: (chunk) => {
      stdout.write(chunk);
    },
  });

  const actions = createSessionActions({
    service,
    mirror,
    overlay,
    links,
    getMode,
    attach,
    ptyRows,
    reportFailure,
  });

  const eject = createEjectScreen({
    service,
    actions,
    links,
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
    findFocusedKey,
    setFocusedKey: (key) => {
      focusedKey = key;
    },
    setLastUsedAgent,
    findFocused,
    scheduleStatus,
  };

  const connection = createTUIDaemonConnection({
    clock,
    bootDaemonClient,
    primary: primaryName,
    links,
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
      handleDaemonEvent(primaryName, raw);
    },
    setLastUsedAgent,
  });

  // The links of the daemons beside the primary open once the primary's first boot is through.
  const handleDaemonEvent = (daemon: DaemonName, raw: DaemonEvent) => {
    applyDaemonEvent(daemon, raw, eventDeps);
    cancelStaleConfirmations();
  };

  // A boot that fails leaves before the first frame, with its message alone:
  // the message holds the daemon and what to do, and a stack would bury it.
  links.onChange((daemon) => {
    cancelStaleConfirmations();

    if (daemon !== primaryName) {
      resumeAttachedSession(daemon);
    }

    if (getMode() === 'overlay') {
      overlay.render();
    }

    scheduleStatus();
  });

  const firstLink = await connection.transport.waitForConnection().catch((error: unknown) => {
    stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

    try {
      process.stdin.setRawMode(false);
    } catch {}

    console.error(`atc: ${error instanceof Error ? error.message : String(error)}`);

    return process.exit(1);
  });

  if (firstLink.restarted) {
    await sendQuiet(primaryName, 'fleet.restore', { cols: cols(), rows: ptyRows() });
  }

  await mirror.refresh(primaryName, connection.getClient());
  await overlay.refreshAgents();

  links.openRemotes();

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
        getClient: connection.getClient,
        restartDaemonAt,
        readConfig: host.readConfig,
        primary: primaryName,
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
    links,
    findFocusedKey,
    findRestartConsent,
    isLeaderKey,
    showBase,
    attach,
    sendInput,
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

    if (getMode() === 'attached' && focusedKey !== null) {
      void sendQuiet(focusedKey.daemon, 'session.resize', {
        session: focusedKey.id,
        cols: cols(),
        rows: ptyRows(),
      });
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
