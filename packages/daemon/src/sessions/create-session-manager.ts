import type { TargetConfigError } from '@atc/config';
import { socketPath, statusFile } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import { systemClock } from '@atc/core';
import type {
  AgentAdapter,
  ExecutionCapability,
  ExecutionProvider,
  HarnessRelay,
  HookPlan,
  SpawnPlan,
} from '@atc/plugin-api';
import type { DeclaredScope, SessionState } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetStore } from '@atc/store';
import type { PublishedRecord, SessionDescriptor, SessionID } from '@atcx/contract';
import { createAuthSetup } from '../auth/create-auth-setup';
import type { RuntimeAuthBinder } from '../auth/create-runtime-auth-binder';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { AuthRebound } from '../auth/types';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { createSessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { createSessionRestorer } from '../fleet/create-session-restorer';
import type { SessionRestorer } from '../fleet/create-session-restorer';
import { collectSessionDescriptors } from './collect-session-descriptors';
import { createHarnessFates } from './create-harness-fates';
import type { HarnessFates } from './create-harness-fates';
import { createHostDirClaims } from './create-host-dir-claims';
import type { HostDirClaims } from './create-host-dir-claims';
import type { PublishedRecords } from './create-published-records';
import { createSessionAdopter } from './create-session-adopter';
import { createSessionHarnesses } from './create-session-harnesses';
import { createSessionHookApplier } from './create-session-hook-applier';
import { createSessionKiller } from './create-session-killer';
import { createSessionRegistry } from './create-session-registry';
import type { SessionRegistry, TargetBinding } from './create-session-registry';
import { createSessionSpawner } from './create-session-spawner';
import type { SessionSpawner, SpawnSessionOptions } from './create-session-spawner';
import { createSpawnRollback } from './create-spawn-rollback';
import { planResumeCommand } from './plan-resume-command';
import type { ResumeCommand } from './plan-resume-command';
import type { Session } from './session';
import type { MessageBridgeLaunch, SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionEventKind } from './session-event-kind';
import { updateSession } from './update-session';
import { updateSessionAttention } from './update-session-attention';
import { updateSessionScope } from './update-session-scope';
import { updateSessionSurfaceState } from './update-session-surface-state';
import { yankSessionHeadless } from './yank-session-headless';

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

  readonly onBoot: (session: Session, cols: number, rows: number) => void;

  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;

  readonly onEvent: (kind: SessionEventKind, session: Session) => void;

  // A host that lost the connection or went to sleep may still run the process, so neither
  // counts as an ended process.
  readonly onProcessEnded: (session: Session) => void;

  readonly startMessageBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  readonly stopMessageBridge: (session: SessionID) => Promise<void>;

  log: (line: string) => void;

  now: () => number;

  clock: Clock;

  reporterSocketPath: string;

  authBinder: RuntimeAuthBinder | null;

  records: PublishedRecords | null;

  sessions: Session[];

  focusedId: SessionID | null;

  readonly hasScreenDetector: boolean;

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
  readonly hasHostLifecycle: (target: string) => boolean;
  readonly removeClaimedDir: HostDirClaims['removeClaimedDir'];
  readonly resolveHostDir: HostDirClaims['resolveHostDir'];
  readonly withRemovalHold: HostDirClaims['withRemovalHold'];
  readonly collectHeldSessions: HostDirClaims['collectHeldSessions'];
  readonly holdSessions: HostDirClaims['holdSessions'];
  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;
  readonly collectChildren: (id: SessionID) => Session[];
  readonly countStates: () => ReturnType<SessionRegistry['countStates']>;
  readonly sortSessions: () => Session[];
  readonly resolveRestoredEntry: (entry: FleetEntry) => Promise<FleetEntry>;
  readonly restore: SessionRestorer['restore'];
  readonly isUnrestored: (id: SessionID) => boolean;
  readonly removeUnrestoredMark: (id: SessionID) => void;
  readonly updateRestoreRefusal: (session: Session, reason: string, code: string | null) => void;

  readonly readHarnessFates: HarnessFates['readFates'];
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
  readonly spawning: SessionSpawner['spawning'];

  readonly kill: (
    id: SessionID,
    stopOnly?: boolean,
  ) => Promise<'stopped' | 'unchanged' | 'removed'>;

  readonly forget: (id: SessionID) => Promise<boolean>;

  readonly probeHarnessEnded: (id: SessionID) => Promise<boolean>;
  readonly pickKillCapability: (session: Session) => ExecutionCapability;
  readonly writeStatus: () => void;
  readonly writeFleet: () => Promise<void>;

  readonly yankHeadless: (id: SessionID) => Session | null;

  readonly updateScope: (
    id: SessionID,
    scope: DeclaredScope,
  ) => Promise<PublishedRecord | 'missing'>;

  readonly updateSession: (
    id: SessionID,
    changes: SessionChanges,
  ) => boolean | 'shared_host' | 'agent_named';

  readonly updateSurfaceState: (
    id: SessionID,
    state: SessionState,
    message: string,
    result?: string,
  ) => void;

  readonly updateAttention: (
    id: SessionID,
    state: 'needs_you' | 'running' | 'done',
    message: string,
  ) => boolean;

  readonly focused: Session | null;
  readonly collectDescriptors: () => SessionDescriptor[];
  readonly applyHook: (hookEvent: HookEvent, previous?: unknown) => HookPlan | null;
  readonly planResumeCommand: (id: SessionID) => ResumeCommand;
  readonly attach: (id: SessionID) => void;
  readonly ack: (id: SessionID) => void;

  readonly detachAll: () => void;

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
  const restarts = { stopRestart: (id: SessionID) => adopter.stopRestart(id) };

  const killer = createSessionKiller({
    registry,
    fleet,
    callbacks,
    restarts,
    readExitWaitMs: () => rollback.failedSpawnExitWaitMs,
  });

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
  const fates = createHarnessFates({ registry, callbacks });

  const adopter = createSessionAdopter({
    registry,
    fleet,
    harnesses,
    rollback,
    auth,
    fates,
    callbacks,
  });

  const spawner = createSessionSpawner({
    registry,
    fleet,
    claims,
    harnesses,
    rollback,
    auth,
    fates,
    callbacks,
  });

  const hooks = createSessionHookApplier({ registry, fleet, store: options.store, callbacks });

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

    hasHostLifecycle: registry.hasHostLifecycle,

    removeClaimedDir: claims.removeClaimedDir,

    resolveHostDir: claims.resolveHostDir,

    withRemovalHold: claims.withRemovalHold,

    collectHeldSessions: claims.collectHeldSessions,

    holdSessions: claims.holdSessions,

    isCallerTree: (id, caller) => registry.isCallerTree(id, caller),

    collectChildren: (id) => registry.collectChildren(id),

    countStates: () => registry.countStates(),

    sortSessions: () => registry.sortSessions(),

    resolveRestoredEntry: (entry) => restorer.resolveRestoredEntry(entry),

    restore: (entry, attention) => restorer.restore(entry, attention),

    isUnrestored: (id) => restorer.isUnrestored(id),

    removeUnrestoredMark: (id) => {
      restorer.removeUnrestoredMark(id);
    },

    readHarnessFates: (scope) => fates.readFates(scope),

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

    spawn: spawner.spawn,

    spawning: spawner.spawning,

    kill: (id, stopOnly = false) => killer.kill(id, stopOnly),

    forget: (id) => killer.forget(id),

    probeHarnessEnded: async (id) => {
      const killed = await killer.probeHarnessEnded(id);
      const rolledBack = await rollback.probeRollbackSettled(id);

      return killed && rolledBack && !harnesses.unconfirmedEnds.has(id);
    },

    pickKillCapability: (session) => killer.pickKillCapability(session),

    writeStatus: () => {
      fleet.writeStatus();
    },

    writeFleet: () => fleet.writeFleet(),

    yankHeadless: (id) => yankSessionHeadless({ registry, fleet, callbacks }, id),

    updateScope: (id, scope) => updateSessionScope({ registry, records }, id, scope),

    updateSession: (id, changes) => updateSession({ registry, fleet, callbacks }, id, changes),

    updateSurfaceState: (id, state, message, result) => {
      updateSessionSurfaceState({ registry, fleet, callbacks }, { id, state, message, result });
    },

    updateAttention: (id, state, message) =>
      updateSessionAttention({ registry, fleet, callbacks }, id, state, message),

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

      // A prompt that is still pending flags the session again on the next notification.
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
