import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import { sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonEvent } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import { systemClock } from '@zgeoff/std';
import invariant from 'tiny-invariant';
import { createActor } from 'xstate';
import { createDaemonLinks } from '../daemon-link/create-daemon-links';
import { createDaemonRestarter } from '../daemon-link/create-daemon-restarter';
import { createTUIDaemonConnection } from '../daemon-link/create-tui-daemon-connection';
import { formatDaemonFailure, sendToDaemon } from '../daemon-link/send-to-daemon';
import { createFleetBarDeps } from '../fleet-bar/create-fleet-bar-deps';
import { applyDaemonEvent } from '../fleet/apply-daemon-event';
import type { DaemonEventDeps } from '../fleet/apply-daemon-event';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import { createFleetRefresher } from '../fleet/create-fleet-refresher';
import { resolveAgentMetadata } from '../fleet/resolve-agent-metadata';
import { toSessionKey } from '../fleet/session-key';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import { toMirrorSession } from '../fleet/to-mirror-session';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { createHomeDeps } from '../home/create-home-deps';
import { isHomeShown } from '../home/is-home-shown';
import { createEjectScreen } from '../overlay/create-eject-screen';
import { createOverlayScreen } from '../overlay/create-overlay-screen';
import { matchLeaderKey } from '../overlay/match-leader-key';
import { createSpawnPicker } from '../picker/create-spawn-picker';
import { createTUIScreen } from '../screen/create-tui-screen';
import { cols } from '../terminal/cols';
import { drawHelp } from '../terminal/draw-help';
import { ptyRows } from '../terminal/pty-rows';
import { restoreTerminal } from '../terminal/restore-terminal';
import { rows } from '../terminal/rows';
import { installScreenSink, writeOut } from '../terminal/write-out';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';
import type { RestartConsent } from './build-client-machine';
import { createAttachment } from './create-attachment';
import { createLinkReactions } from './create-link-reactions';
import { createSessionActions } from './create-session-actions';
import { createStatusNotices } from './create-status-notices';
import { createStatusScheduler } from './create-status-scheduler';
import { drawModeScreen } from './draw-mode-screen';
import { handleResize } from './handle-resize';
import { isOverSession } from './is-over-session';
import type { TUIHost } from './tui-host';

export async function runTUI(host: TUIHost): Promise<void> {
  const [primary] = host.daemons;

  invariant(primary !== undefined, 'the host passes the client at least its primary daemon');

  const primaryName: DaemonName = primary.name;
  const bootDaemonClient = primary.bootDaemon;

  const restartDaemonAt =
    primary.name === null
      ? primary.restartDaemon
      : (): Promise<boolean> =>
          Promise.reject(
            new Error(`daemon '${primary.name}' runs on another host; restart it on that host`),
          );

  const logClientEvent = host.logEvent;
  const mirror = createFleetMirror(primaryName);
  let focusedKey: SessionKey | null = null;
  let lastUsedAgent: AgentID = host.readConfig().defaultAgent;

  // the scheduler comes later, because it reads what the notices and the screen hold
  const notices = createStatusNotices({
    clock: systemClock,
    scheduleStatus: () => {
      scheduleStatus();
    },
  });

  const stdout = process.stdout;
  const leader = host.readConfig().leader;
  const isShowingSession = () => isOverSession(getMode(), findRestartConsent(), findFocused());
  const isSessionFocused = (): boolean => getMode() === 'attached' && findRestartConsent() === null;

  const screen = createTUIScreen({
    clock: systemClock,
    write: (chunk) => {
      stdout.write(chunk);
    },
    readSize: () => ({ cols: cols(), rows: rows() }),
    env: { colorterm: process.env['COLORTERM'], term: process.env['TERM'] },
    animations: host.readConfig().animations,
    isSessionFocused,
    isSessionShown: () => isShowingSession(),
    sessionList: {
      isOpen: () => getMode() === 'overlay',
      canFadeOut: () => ['attached', 'home'].includes(getMode()),
      isOverSession: () => isShowingSession(),
      readInput: (nowMs, spinnerFrame) => overlay.readInput(nowMs, spinnerFrame),
    },
    fleetBar: createFleetBarDeps({
      mirror,
      links: () => links,
      leaderLabel: leader.label,
      findFocused: () => findFocused(),
      isShown: () => isShowingSession() && notices.read() === null && !isAttachedLinkDown(),
    }),
    home: createHomeDeps({
      mirror,
      listVisible: () => overlay.listVisible(),
      leaderLabel: leader.label,
      readNoticeSource: () => ({
        daemonName: primaryName,
        notice: notices.read(),
        isWaiting: isDaemonWaiting(),
        isRestarting: isDaemonRestarting(),
        isStale: getBoot().stale,
      }),
    }),
    isHomeShown: () =>
      isHomeShown({
        mode: getMode(),
        isSessionShown: isShowingSession(),
        isPrompting: findRestartConsent() !== null,
      }),
    sendSessionReply: (key, bytes) => {
      void sendInput(key, bytes);
    },
  });

  installScreenSink(screen.writeScreen);

  const findFocused = (): MirrorSession | null =>
    focusedKey === null ? null : (mirror.find(toSessionKey(focusedKey)) ?? null);

  const openHome = () => {
    attachment.detach();

    focusedKey = null;

    screen.writeScreen(ansi.clear + ansi.hideCursor);

    scheduleStatus();
  };

  const openAttached = (key: SessionKey) => {
    focusedKey = key;

    screen.writeScreen(ansi.clear);

    scheduleStatus();
  };

  const scheduleStatus = createStatusScheduler({
    primaryName,
    leaderLabel: leader.label,
    isOverSession: isShowingSession,
    isListOpen: () => getMode() === 'overlay',
    isHome: () => getMode() === 'home',
    getBoot: () => getBoot(),
    findFocused,
    listVisible: () => overlay.listVisible(),
    isAttachedLinkDown: () => isAttachedLinkDown(),
    isDaemonRestarting: () => isDaemonRestarting(),
    isDaemonWaiting: () => isDaemonWaiting(),
    findNotice: notices.read,
    requestFrame: screen.requestFrame,
  });

  const isAttachedLinkDown = (): boolean =>
    getMode() === 'attached' &&
    focusedKey !== null &&
    focusedKey.daemon !== primaryName &&
    links.stateOf(focusedKey.daemon).kind !== 'up';

  const reportFailure = (daemon: DaemonName, error: unknown) => {
    const text = formatDaemonFailure(daemon, error);

    if (text !== null) {
      notices.show(text);
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

  const sendInput = async (key: SessionKey, data: string) => {
    try {
      await sendToDaemon(links, key.daemon, 'session.input', { session: key.id, data });
    } catch (error) {
      reportFailure(key.daemon, error);
    }
  };

  const attachment = createAttachment({
    links: {
      clientFor: (daemon) => links.clientFor(daemon),
      stateOf: (daemon) => links.stateOf(daemon),
    },
    stream: screen.stream,
    readService: () => service,
    findFocused,
    readSize: () => ({ cols: cols(), rows: ptyRows() }),
    sendQuiet,
    showStatusNotice: notices.show,
    reportFailure,
  });

  const attach = attachment.attach;
  const reattach = attachment.reattach;
  const showBase = attachment.showBase;

  const openHelp = () => {
    screen.writeScreen(ansi.clear);

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
    attachment.detach();
    links.stop();
    connection.transport.stop();
    screen.stop();

    restoreTerminal(screen.hasKittyKeyboard());

    if (message !== undefined) {
      console.error(message);
    }

    process.exit(code);
  };

  // A fullscreen session can leave the terminal in an enhanced keyboard
  // encoding, so the leader arrives as a CSI chord instead of its bare byte.
  const isLeaderKey = (buf: Buffer): boolean =>
    matchLeaderKey(leader.code, buf.toString()) === 'press';

  const getMode = () => service.getSnapshot().value.mode;
  const getConfirm = () => service.getSnapshot().value.confirm;
  const findRestartConsent = (): RestartConsent | null => service.getSnapshot().context.consent;
  const getBoot = (): DaemonBoot => connection.getBoot();
  const isDaemonWaiting = (): boolean => service.getSnapshot().matches({ daemon: 'waiting' });
  const isDaemonRestarting = (): boolean => service.getSnapshot().matches({ daemon: 'restarting' });

  const drawMode = () => {
    drawModeScreen({
      mode: getMode(),
      overlay,
      picker,
      eject,
      openHelp,
      write: screen.writeScreen,
    });

    scheduleStatus();
  };

  const links = createDaemonLinks({
    daemons: host.daemons,
    clock: systemClock,
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

    write: (chunk) => {
      if (findRestartConsent() === null) {
        writeOut(chunk);
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
    clock: systemClock,
  });

  const service = createActor(
    buildClientMachine({
      openHome,
      openAttached,
      openOverlay: () => {
        screen.writeScreen(ansi.clear + ansi.hideCursor);
        notices.dropHome();
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
    bootMetadata: resolveAgentMetadata(host.readConfig(), {}),
    readConfig: host.readConfig,
    links,
    findFocusedKey,
    getMode,
    getConfirm,
    findConfirmKey: () => service.getSnapshot().context.confirmKey,
    isBootStale: () => getBoot().stale,
    isDaemonRestarting,
    isDaemonWaiting,
    scheduleStatus,
    requestFrame: screen.requestFrame,
  });

  const actions = createSessionActions({
    service,
    mirror,
    overlay,
    links,
    getMode,
    attach,
    ptyRows,
    findFocusedKey,
    reportFailure,
    showHomeNotice: notices.showHome,
  });

  const eject = createEjectScreen({
    service,
    actions,
    links,
    isLeaderKey,
    showBase,
    scheduleStatus,
  });

  const fleetRefresher = createFleetRefresher({
    mirror,
    readClient: () => connection.getClient(),
    onRefreshed: scheduleStatus,
  });

  const eventDeps: DaemonEventDeps = {
    onLivenessChange: fleetRefresher.refresh,
    service,
    mirror,
    overlay,
    clock: systemClock,
    getMode,
    findFocusedKey,
    setFocusedKey: (key) => {
      focusedKey = key;
    },
    setLastUsedAgent,
    findFocused,
    scheduleStatus,
    stream: screen.stream,
  };

  const connection = createTUIDaemonConnection({
    clock: systemClock,
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
    write: screen.writeScreen,
    reattach,
    sendQuiet,
    showStatusNotice: notices.show,
    scheduleStatus,
  });

  const handleDaemonEvent = (daemon: DaemonName, raw: DaemonEvent) => {
    applyDaemonEvent(daemon, raw, eventDeps);

    reactions.cancelStaleConfirmations();
  };

  links.onChange(reactions.handleLinkChange);

  const firstLink = await connection.transport.waitForConnection().catch((error: unknown) => {
    restoreTerminal(screen.hasKittyKeyboard());

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
    clock: systemClock,
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

  // A multi-byte character split across two stdin reads must not be mangled by per-chunk toString().
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
    paste: { isOpen: false },
    restartDaemonOnce,
    logClientEvent,
    quit,
  };

  process.stdin.on('data', (chunk: Buffer) => {
    const keys = screen.filterInput(chunk);

    if (keys === null || matchLeaderKey(leader.code, keys.toString()) === 'release') {
      return;
    }

    applyInputKey(keys, inputDeps);
  });

  stdout.on('resize', () => {
    screen.handleResize();

    handleResize({
      attachedKey: attachment.readAttachedKey(),
      restartPrompt: findRestartConsent()?.prompt ?? null,
      ptyRows: ptyRows(),
      write: screen.writeScreen,
      sendQuiet,
      drawMode,
    });
  });

  process.on('uncaughtException', (err) => {
    screen.stop();

    restoreTerminal(screen.hasKittyKeyboard());

    console.error(err);
    process.exit(1);
  });

  process.on('SIGTERM', () => quit());
  process.on('SIGHUP', () => quit());
  stdout.write(ansi.altScreenOn);
  screen.start();
  service.start();
}
