import type { TargetConfigError } from '@atc/config';
import { socketPath, statusFile } from '@atc/config';
import type { AgentID, Clock, SessionID } from '@atc/core';
import { systemClock, truncateDetail, truncateToBytes } from '@atc/core';
import type {
  AgentAdapter,
  ExecutionCapability,
  ExecutionProvider,
  HarnessRelay,
  HookPlan,
  SpawnPlan,
} from '@atc/plugin-api';
import type {
  DeclaredScope,
  PublishedRecord,
  SessionDescriptor,
  SessionState,
} from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetStore } from '@atc/store';
import { createAuthSetup } from '../auth/create-auth-setup';
import type { AuthRebound } from '../auth/create-auth-setup';
import type { RuntimeAuthBinder } from '../auth/create-runtime-auth-binder';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { createSessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { createSessionRestorer } from '../fleet/create-session-restorer';
import { collectSessionDescriptors } from './collect-session-descriptors';
import { createHostDirClaims } from './create-host-dir-claims';
import type { PublishedRecords } from './create-published-records';
import { createSessionAdopter } from './create-session-adopter';
import { createSessionHarnesses } from './create-session-harnesses';
import { createSessionHookApplier } from './create-session-hook-applier';
import { createSessionKiller } from './create-session-killer';
import { createSessionRegistry } from './create-session-registry';
import type { SessionRegistry, TargetBinding } from './create-session-registry';
import { createSessionSpawner } from './create-session-spawner';
import type { SpawnSessionOptions } from './create-session-spawner';
import { createSpawnRollback } from './create-spawn-rollback';
import { planResumeCommand } from './plan-resume-command';
import type { ResumeCommand } from './plan-resume-command';
import type { Session } from './session';
import type { MessageBridgeLaunch, SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionEventKind } from './session-event-kind';
import { updateSession } from './update-session';
import { updateSessionScope } from './update-session-scope';

type SessionManagerEvents = Partial<
  Pick<
    SessionCallbacks,
    | 'onOutput'
    | 'onChange'
    | 'onBoot'
    | 'onRelay'
    | 'onEvent'
    | 'onProcessEnded'
    | 'startMessageBridge'
    | 'stopMessageBridge'
  >
>;

export interface SessionManager {
  readonly onOutput: (session: Session, data: string) => void;

  readonly onChange: () => void;

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  readonly onBoot: (session: Session, cols: number, rows: number) => void;

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;

  readonly onEvent: (kind: SessionEventKind, session: Session) => void;

  // Called when a session's process is known to have ended: it exited or
  // it was killed. A host that lost the connection or went to sleep may
  // still run the process, so neither calls it.
  readonly onProcessEnded: (session: Session) => void;

  // Starts the bridge that takes a local session's messages, when its agent
  // has one; with none given, every session starts without one.
  readonly startMessageBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  readonly stopMessageBridge: (session: SessionID) => Promise<void>;

  // Where a background failure is reported, one line at a time: stderr,
  // like the daemon's other background failures.
  log: (line: string) => void;

  // The clock each remote launch's step timing reads, in milliseconds.
  now: () => number;

  // The clock a session's creation and last attach are stamped with.
  clock: Clock;

  // The socket each session's hooks report to, which the daemon's hook
  // server listens on.
  reporterSocketPath: string;

  // Binds the runtime auth of each host whose agent takes its credential
  // from impd's broker; with none, every such start is refused.
  authBinder: RuntimeAuthBinder | null;

  // Publishes each session's record before its harness starts; with none,
  // sessions start without a record.
  records: PublishedRecords | null;

  sessions: Session[];

  focusedId: SessionID | null;

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward.
  readonly hasScreenDetector: boolean;

  // How long a failed spawn's rollback waits for the killed process to
  // exit, in milliseconds, once after its kill and once more after a forced
  // kill.
  failedSpawnExitWaitMs: number;

  readonly requireExecution: (
    binding: Readonly<TargetBinding>,
    capability: ExecutionCapability,
  ) => { readonly provider: ExecutionProvider; readonly identity: string };

  readonly findExecutionRefusal: (
    binding: Readonly<{ target: string | null; targetIdentity: string | null }>,
    capability: ExecutionCapability,
  ) => DaemonError | null;

  readonly findProvider: (session: Session) => ExecutionProvider | null;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;
  readonly collectAdapters: () => AgentAdapter[];
  readonly isLocalTarget: (target: string) => boolean;
  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;
  readonly collectChildren: (id: SessionID) => Session[];
  readonly countStates: () => ReturnType<SessionRegistry['countStates']>;
  readonly sortSessions: () => Session[];
  readonly resolveRestoredEntry: (entry: FleetEntry) => Promise<FleetEntry>;
  readonly restore: (entry: FleetEntry) => Session;
  readonly isUnrestored: (id: SessionID) => boolean;
  readonly removeUnrestoredMark: (id: SessionID) => void;
  readonly updateRestoreRefusal: (session: Session, reason: string, code: string | null) => void;
  readonly updateRestoredIdentity: (session: Session, identity: string) => void;
  readonly requireAgentTarget: (agent: AgentID, target: string) => void;
  readonly revokeAuth: (id: SessionID) => Promise<boolean>;
  readonly updateAuth: (id: SessionID) => Promise<AuthRebound | null>;

  readonly adoptTerminal: (
    id: SessionID,
    cols: number,
    rows: number,
    canProceed?: () => boolean,
  ) => Promise<Session | null>;

  readonly spawn: (options: SpawnSessionOptions) => Promise<Session>;

  readonly kill: (
    id: SessionID,
    stopOnly?: boolean,
  ) => Promise<'stopped' | 'unchanged' | 'removed'>;

  readonly forget: (id: SessionID) => Promise<boolean>;
  readonly pickKillCapability: (session: Session) => ExecutionCapability;
  readonly writeStatus: () => void;
  readonly writeFleet: () => Promise<void>;

  // Hands a live terminal session off to a headless run: the terminal dies,
  // the record lives on as a headless session and keeps its screen history.
  readonly yankHeadless: (id: SessionID) => Session | null;

  readonly updateScope: (
    id: SessionID,
    scope: DeclaredScope,
  ) => Promise<PublishedRecord | 'missing'>;

  readonly updateSession: (
    id: SessionID,
    changes: SessionChanges,
  ) => boolean | 'shared_host' | 'agent_named';

  // A result, when given, becomes the session's latest result the way a
  // terminal turn's final message does.
  readonly updateSurfaceState: (
    id: SessionID,
    state: SessionState,
    message: string,
    result?: string,
  ) => void;

  // The detector-stack screen tier reports through here: only flips between
  // running and needs_you — hook-driven done/exited states always win.
  readonly updateAttention: (
    id: SessionID,
    state: 'needs_you' | 'running',
    message: string,
  ) => void;

  readonly focused: Session | null;
  readonly collectDescriptors: () => SessionDescriptor[];
  readonly applyHook: (hookEvent: HookEvent, previous?: unknown) => HookPlan | null;
  readonly planResumeCommand: (id: SessionID) => ResumeCommand;
  readonly attach: (id: SessionID) => void;
  readonly ack: (id: SessionID) => void;

  // Lets go of every harness as the daemon stops: one on the daemon's own
  // machine ends with it, and one on a remote host runs on for the next
  // daemon to attach.
  readonly detachAll: () => void;

  // A harness detaches once, so a disposal after a detach of every harness
  // lets go of nothing again.
  readonly [Symbol.dispose]: () => void;
}

interface CreateSessionManagerOptions {
  readonly fallback?: AgentAdapter | null | undefined;
  readonly store: FleetStore;
  readonly statusPath?: string | undefined;
  readonly adapters?: readonly AgentAdapter[] | undefined;
  readonly targets?: readonly ExecutionTarget[] | undefined;
  readonly targetErrors?: readonly TargetConfigError[] | undefined;
  readonly events?: SessionManagerEvents | undefined;
}

// events are taken at build time, so no session event arrives before its
// handler exists
export function createSessionManager(options: CreateSessionManagerOptions): SessionManager {
  const events = options.events ?? {};
  let log: (line: string) => void = writeStderrLine;
  let now: () => number = readPerformanceNow;
  let clock: Clock = systemClock;
  let reporterSocketPath = socketPath;
  let authBinder: RuntimeAuthBinder | null = null;
  let records: PublishedRecords | null = null;
  const onOutput = events.onOutput ?? (() => {});
  const onChange = events.onChange ?? (() => {});
  const onBoot = events.onBoot ?? (() => {});
  const onRelay = events.onRelay ?? (() => {});
  const onEvent = events.onEvent ?? (() => {});
  const onProcessEnded = events.onProcessEnded ?? (() => {});
  const startMessageBridge = events.startMessageBridge ?? (() => Promise.resolve(null));
  const stopMessageBridge = events.stopMessageBridge ?? (() => Promise.resolve());

  // Each module reads the daemon's settings at the moment it acts, since
  // the daemon sets them after the manager is built.
  const callbacks: SessionCallbacks = {
    onOutput,
    onChange,
    onBoot,
    onRelay,
    onEvent,
    onProcessEnded,
    startMessageBridge,
    stopMessageBridge,
    log: (line) => {
      log(line);
    },
    now: () => now(),
    getClock: () => clock,
    getReporterSocketPath: () => reporterSocketPath,
    findAuthBinder: () => authBinder,
    findRecords: () => records,
  };

  const registry = createSessionRegistry({
    fallback: options.fallback,
    adapters: options.adapters ?? [],
    targets: options.targets ?? [],
    targetErrors: options.targetErrors ?? [],
    callbacks,
  });

  const fleet = createSessionFleetWriter({
    registry,
    store: options.store,
    statusPath: options.statusPath ?? statusFile,
    callbacks,
  });

  const claims = createHostDirClaims({ registry });

  // The killer reaches the adopter, built after it, only once a kill runs.
  const restarts = { stopRestart: (id: SessionID) => adopter.stopRestart(id) };
  const killer = createSessionKiller({ registry, fleet, callbacks, restarts });
  const harnesses = createSessionHarnesses({ registry, fleet, killer, callbacks });
  const rollback = createSpawnRollback({ registry, fleet, claims, harnesses, callbacks });

  const auth = createAuthSetup({
    registry,
    fleet,
    claims,
    harnesses,
    rollback,
    store: options.store,
    callbacks,
  });

  const restorer = createSessionRestorer({ registry, fleet, callbacks });
  const adopter = createSessionAdopter({ registry, fleet, harnesses, rollback, auth, callbacks });

  const spawner = createSessionSpawner({
    registry,
    fleet,
    claims,
    harnesses,
    rollback,
    auth,
    callbacks,
  });

  const hooks = createSessionHookApplier({ registry, fleet, callbacks });

  const detachAll = () => {
    for (const session of registry.sessions) {
      session.pty?.detach();
    }
  };

  return {
    onOutput,
    onChange,
    onBoot,
    onRelay,
    onEvent,
    onProcessEnded,
    startMessageBridge,
    stopMessageBridge,

    get log() {
      return log;
    },

    set log(next: (line: string) => void) {
      log = next;
    },

    get now() {
      return now;
    },

    set now(next: () => number) {
      now = next;
    },

    get clock() {
      return clock;
    },

    set clock(next: Clock) {
      clock = next;
    },

    get reporterSocketPath() {
      return reporterSocketPath;
    },

    set reporterSocketPath(next: string) {
      reporterSocketPath = next;
    },

    get authBinder() {
      return authBinder;
    },

    set authBinder(next: RuntimeAuthBinder | null) {
      authBinder = next;
    },

    get records() {
      return records;
    },

    set records(next: PublishedRecords | null) {
      records = next;
    },

    get sessions(): Session[] {
      return registry.sessions;
    },

    set sessions(sessions: Session[]) {
      registry.sessions = sessions;
    },

    get focusedId(): SessionID | null {
      return registry.focusedId;
    },

    set focusedId(id: SessionID | null) {
      registry.focusedId = id;
    },

    get hasScreenDetector(): boolean {
      return registry.hasScreenDetector;
    },

    get failedSpawnExitWaitMs(): number {
      return rollback.failedSpawnExitWaitMs;
    },

    set failedSpawnExitWaitMs(waitMs: number) {
      rollback.failedSpawnExitWaitMs = waitMs;
    },

    requireExecution: (binding, capability) => registry.requireExecution(binding, capability),

    findExecutionRefusal: (binding, capability) =>
      registry.findExecutionRefusal(binding, capability),

    findProvider: (session) => registry.findProvider(session),

    findAdapter: (id) => registry.findAdapter(id),

    collectAdapters: () => registry.collectAdapters(),

    isLocalTarget: (target) => registry.isLocalTarget(target),

    isCallerTree: (id, caller) => registry.isCallerTree(id, caller),

    collectChildren: (id) => registry.collectChildren(id),

    countStates: () => registry.countStates(),

    sortSessions: () => registry.sortSessions(),

    resolveRestoredEntry: (entry) => restorer.resolveRestoredEntry(entry),

    restore: (entry) => restorer.restore(entry),

    isUnrestored: (id) => restorer.isUnrestored(id),

    removeUnrestoredMark: (id) => {
      restorer.removeUnrestoredMark(id);
    },

    updateRestoreRefusal: (session, reason, code) => {
      restorer.updateRestoreRefusal(session, reason, code);
    },

    updateRestoredIdentity: (session, identity) => {
      restorer.updateRestoredIdentity(session, identity);
    },

    requireAgentTarget: (agent, target) => {
      auth.requireAgentTarget(agent, target);
    },

    revokeAuth: (id) => auth.revokeAuth(id),

    updateAuth: (id) => auth.updateAuth(id),

    adoptTerminal: (id, cols, rows, canProceed = () => true) =>
      adopter.adoptTerminal(id, cols, rows, canProceed),

    spawn: (spawnOptions) => spawner.spawn(spawnOptions),

    kill: (id, stopOnly = false) => killer.kill(id, stopOnly),

    forget: (id) => killer.forget(id),

    pickKillCapability: (session) => killer.pickKillCapability(session),

    writeStatus: () => {
      fleet.writeStatus();
    },

    writeFleet: () => fleet.writeFleet(),

    yankHeadless: (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (!session || session.pty === null || session.agentSessionID === undefined) {
        return null;
      }

      const pty = session.pty;

      session.pty = null;
      session.kind = 'headless';
      session.state = 'running';
      session.lastMsg = 'ejected to headless';

      pty.kill();

      onEvent('state', session);

      fleet.emitChange();

      return session;
    },

    updateScope: (id, scope) => updateSessionScope({ registry, records }, id, scope),

    updateSession: (id, changes) => updateSession({ registry, fleet, callbacks }, id, changes),

    updateSurfaceState: (id, state, message, result) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (!session || session.kind !== 'headless') {
        return;
      }

      session.state = state;
      session.lastMsg = message;
      session.unread = registry.focusedId !== session.id;

      if (result !== undefined) {
        session.result = truncateToBytes(result, 16_384);
        session.lastDetail = truncateDetail(result);
        void fleet.tryUpdateFleetEntry(session.id, { result: session.result });
      }

      onEvent('state', session);

      fleet.emitChange();
    },

    updateAttention: (id, state, message) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (!session || session.pty === null || session.state === state) {
        return;
      }

      if (session.state !== 'running' && session.state !== 'needs_you') {
        return;
      }

      session.state = state;
      session.lastMsg = message;

      if (state === 'needs_you') {
        session.unread = registry.focusedId !== session.id;
      }

      onEvent('state', session);

      fleet.emitChange();
    },

    get focused(): Session | null {
      return registry.sessions.find((session) => session.id === registry.focusedId) ?? null;
    },

    collectDescriptors: () => collectSessionDescriptors(registry, options.store),

    applyHook: (hookEvent, previous) => hooks.applyHook(hookEvent, previous),

    planResumeCommand: (id) => planResumeCommand(registry, id),

    attach: (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (!session) {
        return;
      }

      session.unread = false;
      session.lastAttachedAt = clock.now();
      void fleet.tryWriteFleet(session.id);

      // Attaching answers the attention request: a still-pending prompt
      // re-flags it via the next notification.
      if (session.state === 'needs_you') {
        session.state = 'running';
        session.lastMsg = 'attached';
      }

      onEvent('state', session);

      fleet.emitChange();
    },

    ack: (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session) {
        session.unread = false;

        onEvent('state', session);
      }

      fleet.emitChange();
    },

    detachAll,

    [Symbol.dispose]: () => {
      detachAll();
    },
  };
}

function writeStderrLine(line: string): void {
  console.error(line);
}

function readPerformanceNow(): number {
  return performance.now();
}
