import type { AgentID } from '@atc/core';
import { ansi, systemClock } from '@atc/core';
import { sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonEvent } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import { createActor } from 'xstate';
import { createDaemonLinks } from '../daemon-link/create-daemon-links';
import { createDaemonRestarter } from '../daemon-link/create-daemon-restarter';
import { createTUIDaemonConnection } from '../daemon-link/create-tui-daemon-connection';
import { formatLinkState } from '../daemon-link/daemon-link-state';
import { formatDaemonFailure, sendToDaemon } from '../daemon-link/send-to-daemon';
import { applyDaemonEvent } from '../fleet/apply-daemon-event';
import type { DaemonEventDeps } from '../fleet/apply-daemon-event';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import { resolveAgentMetadata } from '../fleet/resolve-agent-metadata';
import { toSessionKey } from '../fleet/session-key';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import { toMirrorSession } from '../fleet/to-mirror-session';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { buildLeaderChords } from '../overlay/build-leader-chords';
import { createEjectScreen } from '../overlay/create-eject-screen';
import { createOverlayScreen } from '../overlay/create-overlay-screen';
import { createSpawnPicker } from '../picker/create-spawn-picker';
import { cols } from '../terminal/cols';
import { drawHelp } from '../terminal/draw-help';
import { drawHome } from '../terminal/draw-home';
import { restoreTerminal } from '../terminal/restore-terminal';
import { rows } from '../terminal/rows';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { createLinkReactions } from './create-link-reactions';
import { createSessionActions } from './create-session-actions';
import { createStatusScheduler } from './create-status-scheduler';
import { drawModeScreen } from './draw-mode-screen';
import { handleResize } from './handle-resize';
import type { TUIHost } from './tui-host';

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

  // Why the last action on a daemon sent nothing or was refused, until it times out.
  let statusNotice: string | null = null;
  let cancelStatusNotice: (() => void) | null = null;

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

  const scheduleStatus = createStatusScheduler({
    primaryName,
    leaderLabel: leader.label,
    getMode: () => getMode(),
    getBoot: () => getBoot(),
    findFocused,
    listVisible: () => overlay.listVisible(),
    isAttachedLinkDown: () => isAttachedLinkDown(),
    isDaemonRestarting: () => isDaemonRestarting(),
    isDaemonWaiting: () => isDaemonWaiting(),
    findNotice: () => statusNotice,
  });

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

  const sendRequest = (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => sendToDaemon(links, daemon, method, params);

  const readLastUsedAgent = (daemon: DaemonName): AgentID =>
    daemon === primaryName
      ? lastUsedAgent
      : (links.lastUsedAgent(daemon) ?? host.readConfig().defaultAgent);

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

    restoreTerminal();

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

  const drawMode = () => {
    drawModeScreen({
      mode: getMode(),
      sessionCount: mirror.count,
      leaderLabel: leader.label,
      overlay,
      picker,
      eject,
      openHelp,
      write: (chunk) => {
        stdout.write(chunk);
      },
    });

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
    primaryDaemon: primaryName,
    upDaemons: links.upDaemons,
    sendRequest,
    ptyRows,
    isLeaderKey,
    getLastUsedAgent: readLastUsedAgent,
    scheduleStatus,
    showBase,
    attach: (daemon, id) => attach({ daemon, id }),
    toMirrorSession: (daemon, value) => toMirrorSession(value, daemon),
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
    readConfig: host.readConfig,
    onDropAnswer: (kind) => {
      logClientEvent(`dropped ${kind} answer`);
    },
    log: logClientEvent,
    getListingCache: (daemon) => host.daemons.find((entry) => entry.name === daemon)?.listingCache,
    getDaemonSocketPath: (daemon) => (daemon === primaryName ? getBoot().socketPath : ''),
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

  const reactions = createLinkReactions({
    primaryName,
    service,
    mirror,
    links,
    overlay,
    picker,
    eject,
    getMode,
    getConfirm,
    findFocusedKey,
    findFocused,
    write: (chunk) => {
      stdout.write(chunk);
    },
    sendQuiet,
    ptyRows,
    showStatusNotice,
    scheduleStatus,
  });

  // The links of the daemons beside the primary open once the primary's first boot is through.
  const handleDaemonEvent = (daemon: DaemonName, raw: DaemonEvent) => {
    applyDaemonEvent(daemon, raw, eventDeps);

    reactions.cancelStaleConfirmations();
  };

  // A boot that fails leaves before the first frame, with its message alone:
  // the message holds the daemon and what to do, and a stack would bury it.
  links.onChange(reactions.handleLinkChange);

  const firstLink = await connection.transport.waitForConnection().catch((error: unknown) => {
    restoreTerminal();

    console.error(`atc: ${error instanceof Error ? error.message : String(error)}`);

    return process.exit(1);
  });

  if (firstLink.restarted) {
    await sendQuiet(primaryName, 'fleet.restore', { cols: cols(), rows: ptyRows() });
  }

  await mirror.refresh(primaryName, connection.getClient());
  await overlay.refreshAgents();

  links.openRemotes();

  const restartDaemonOnce = createDaemonRestarter({
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
    handleResize({
      mode: getMode(),
      focusedKey,
      restartPrompt: findRestartConsent()?.prompt ?? null,
      ptyRows: ptyRows(),
      write: (chunk) => {
        stdout.write(chunk);
      },
      sendQuiet,
      drawMode,
    });
  });

  process.on('uncaughtException', (err) => {
    restoreTerminal();

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
