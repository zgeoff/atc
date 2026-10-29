import { join } from 'node:path';
import type { InvalidGitTransports, TargetConfigError } from '@atc/config';
import { parseRestoreBootTimeoutMs } from '@atc/config';
import type { Clock } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import { createRuntimeAuthBinder } from './auth/create-runtime-auth-binder';
import type { RuntimeAuthBinder } from './auth/create-runtime-auth-binder';
import { tryReconcileAuthBindings } from './auth/try-reconcile-auth-bindings';
import type { TapClient } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import { createFleetRestorer } from './fleet/create-fleet-restorer';
import type { FleetRestorer } from './fleet/create-fleet-restorer';
import { createConfirmTokens } from './sessions/create-confirm-tokens';
import { createHookIntake } from './sessions/create-hook-intake';
import type { HookIntake } from './sessions/create-hook-intake';
import { createMessageBridges } from './sessions/create-message-bridges';
import type { MessageBridges } from './sessions/create-message-bridges';
import { createMessageService } from './sessions/create-message-service';
import type { MessageService } from './sessions/create-message-service';
import { createPublishedRecords } from './sessions/create-published-records';
import type { PublishedRecords } from './sessions/create-published-records';
import { createScreenDetection } from './sessions/create-screen-detection';
import type { ScreenDetection } from './sessions/create-screen-detection';
import { createSessionForgetter } from './sessions/create-session-forgetter';
import type { SessionForgetter } from './sessions/create-session-forgetter';
import { createSessionHandoff } from './sessions/create-session-handoff';
import type { SessionHandoff } from './sessions/create-session-handoff';
import { createSessionInput } from './sessions/create-session-input';
import type { SessionInput } from './sessions/create-session-input';
import type { SessionManager } from './sessions/create-session-manager';
import { createSessionOutput } from './sessions/create-session-output';
import type { SessionOutput } from './sessions/create-session-output';
import { createSessionReads } from './sessions/create-session-reads';
import type { SessionReads } from './sessions/create-session-reads';
import type { SessionRuntime } from './sessions/create-session-runtime';
import { createSpawnService } from './sessions/create-spawn-service';
import type { SpawnService } from './sessions/create-spawn-service';
import type { TapRegistry } from './sessions/create-tap-registry';
import { startHookServer } from './sessions/hooks';
import type { HookScope } from './sessions/make-hook-runner';
import { MENU_TIMING } from './sessions/menu-terminal';
import { startBridgeRevival } from './sessions/start-bridge-revival';
import type { BridgeRevival } from './sessions/start-bridge-revival';
import { startHeadlessTurn } from './sessions/start-headless-turn';
import { createSpawnCatalog } from './sources/create-spawn-catalog';
import type { SpawnCatalog } from './sources/create-spawn-catalog';
import type { EventSignal } from './transport/create-event-signal';
import { createEventTrail } from './transport/create-event-trail';
import type { EventTrail } from './transport/create-event-trail';
import { createIdempotencyLedger } from './transport/create-idempotency-ledger';
import type { IdempotencyLedger } from './transport/create-idempotency-ledger';

export interface SessionServicesDeps {
  readonly opts: DaemonOptions;
  readonly manager: SessionManager;
  readonly store: StateStore;
  readonly clock: Clock;
  readonly stateDir: string;
  readonly targets: readonly ExecutionTarget[];
  readonly targetsByID: ReadonlyMap<string, ExecutionTarget>;
  readonly targetErrors: readonly TargetConfigError[];
  readonly gitTransports: readonly string[] | InvalidGitTransports;
  readonly defaultTarget: string | null;
  readonly taps: TapRegistry<TapClient>;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly eventSignal: EventSignal;
  readonly emitEvent: (event: EventMsg, scope?: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;
  readonly endedProcesses: ReadonlySet<SessionID>;

  // Whether the daemon has begun to release what it holds.
  readonly isStopped: () => boolean;
}

export interface SessionServices {
  readonly records: PublishedRecords;
  readonly authBinder: RuntimeAuthBinder;
  readonly ledger: IdempotencyLedger;
  readonly messages: MessageService;
  readonly hooks: HookIntake;
  readonly bridges: MessageBridges;
  readonly trail: EventTrail;
  readonly detection: ScreenDetection;
  readonly output: SessionOutput;
  readonly input: SessionInput;
  readonly handoff: SessionHandoff;
  readonly reads: SessionReads;
  readonly reporter: ReturnType<typeof startHookServer>;
  readonly revival: BridgeRevival;
  readonly spawns: SpawnService;
  readonly forgetter: SessionForgetter;
  readonly catalog: SpawnCatalog;
  readonly restorer: FleetRestorer;
}

// How long a started Claude session may go without a tap before a message to
// it is refused.
const TAP_GRACE_MS = 15_000;

// How long a confirm token from a forget that destroys a host stays usable.
const FORGET_CONFIRM_MS = 60_000;

// The principal every request on the local socket acts as.
const LOCAL_PRINCIPAL = 'local';

// Builds the services around the session manager in dependency order, hands the manager the ones
// it calls, and starts the reporter socket that hook events arrive on.
export function startSessionServices(deps: SessionServicesDeps): SessionServices {
  const opts = deps.opts;
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const stateDir = deps.stateDir;
  const targets = deps.targets;
  const targetsByID = deps.targetsByID;
  const targetErrors = deps.targetErrors;
  const gitTransports = deps.gitTransports;
  const defaultTarget = deps.defaultTarget;
  const taps = deps.taps;
  const findRuntime = deps.findRuntime;
  const eventSignal = deps.eventSignal;
  const emitEvent = deps.emitEvent;
  const findHookScope = deps.findHookScope;
  const endedProcesses = deps.endedProcesses;
  const isStopped = deps.isStopped;

  const records = createPublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(stateDir, 'records'),
    ghBin: opts.ghBin ?? 'gh',
    now: () => clock.now(),
  });

  manager.records = records;

  const authBinder = createRuntimeAuthBinder(store, () => clock.now());

  manager.authBinder = authBinder;

  // Settled in the background, since it reaches each target's broker: each binding a
  // stopped daemon left mid-change stays blocked until it is settled.
  void tryReconcileAuthBindings(authBinder, store, targetsByID, manager.log);

  const ledger = createIdempotencyLedger(
    store,
    LOCAL_PRINCIPAL,
    (line) => {
      manager.log(line);
    },
    clock,
  );

  const messages = createMessageService({
    manager,
    store,
    clock,
    ledger,
    taps,
    findRuntime,
    eventSignal,
    emitEvent,
    findHookScope,
    isProcessEnded: (sessionID) => endedProcesses.has(sessionID),
    tapGraceMs: opts.tapGraceMs ?? TAP_GRACE_MS,
  });

  const hooks = createHookIntake({
    manager,
    store,
    clock,
    messages,
    taps,
    findRuntime,
    eventSignal,
    emitEvent,
    findHookScope,
    updateBridgeThread: (sessionID, agentSessionID) => {
      bridges.updateThread(sessionID, agentSessionID);
    },
    onAgentStarted: (sessionID) => {
      revival.watchAgentStart(sessionID);
      detection.applyAgentStart(sessionID);
    },
    ...(opts.onNoteIgnored === undefined ? {} : { onNoteIgnored: opts.onNoteIgnored }),
    ...(opts.onLastUsedUnchanged === undefined
      ? {}
      : { onLastUsedUnchanged: opts.onLastUsedUnchanged }),
  });

  const bridges = createMessageBridges({
    manager,
    store,
    clock,
    messages,
    taps,
    applyNote: (hookEvent) => hooks.applyNote(hookEvent),
    stateDir,
  });

  // The revival notes each write through the hook intake, so the note lands
  // in the session's events like one the session sent.
  const revival = startBridgeRevival({
    manager,
    taps,
    clock,
    isProcessEnded: (sessionID) => endedProcesses.has(sessionID),
    applyNote: (hookEvent) => hooks.applyNote(hookEvent),
  });

  const trail = createEventTrail({ manager, store, clock, eventSignal });

  const detection = createScreenDetection({
    manager,
    clock,
    findRuntime,
    recordNeedsInput: (sessionID, message) => {
      hooks.recordScreenNeedsInput(sessionID, message);
    },
    onDetectSkipped: opts.onDetectSkipped,
  });

  const output = createSessionOutput({
    manager,
    clock,
    findRuntime,
    emitEvent,
    findHookScope,
    scheduleDetect: (sessionID) => {
      detection.scheduleDetect(sessionID);
    },
  });

  const startTurn = (sessionID: SessionID, prompt: string) =>
    startHeadlessTurn({
      manager,
      findRuntime,
      sessionID,
      prompt,
      recordTurnEvent: (turnSessionID, ev) => {
        hooks.recordHeadlessTurnEvent(turnSessionID, ev);
      },
      reporterSocket: opts.reporterSocketPath,
    });

  const input = createSessionInput({
    manager,
    clock,
    findRuntime,
    menuTiming: opts.menuTiming ?? MENU_TIMING,
    startHeadlessTurn: startTurn,
  });

  const handoff = createSessionHandoff({
    manager,
    findRuntime,
    ejectSettleMs: opts.ejectSettleMs ?? 4000,
    scheduleEjectSettle: opts.scheduleEjectSettle ?? clock.schedule,
    startHeadlessTurn: startTurn,
    scheduleResize: (sessionID) => {
      output.scheduleResize(sessionID);
    },
  });

  const reads = createSessionReads({ manager, store, records });

  const reporter = startHookServer((hookEvent) => {
    hooks.applyHookEvent(hookEvent);
  }, opts.reporterSocketPath);

  const spawns = createSpawnService({
    manager,
    store,
    clock,
    ledger,
    findRuntime,
    gitTransports,
    defaultTarget,
    ...(opts.workspaceRoots === undefined ? {} : { workspaceRoots: opts.workspaceRoots }),
    ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
  });

  const forgetter = createSessionForgetter({
    manager,
    findRuntime,
    tokens: createConfirmTokens({
      now: opts.forgetClock ?? (() => clock.now()),
      lifetimeMs: opts.forgetConfirmMs ?? FORGET_CONFIRM_MS,
    }),
  });

  const catalog = createSpawnCatalog({
    manager,
    store,
    build: opts.build,
    targets,
    defaultTarget,
    targetErrors,
    ...(opts.defaultAgent === undefined ? {} : { defaultAgent: opts.defaultAgent }),
    sources: opts.sources ?? [],
    gitTransports,
  });

  const restorer = createFleetRestorer({
    manager,
    store,
    clock,
    findRuntime,
    capMs: opts.restoreBootTimeoutMs ?? parseRestoreBootTimeoutMs(process.env),
    retryDelaysMs: opts.restoreRetryDelaysMs,
    isStopped,
    onRestoreSettled: opts.onRestoreSettled,
    onRestoreSkipped: opts.onRestoreSkipped,
  });

  return {
    records,
    authBinder,
    ledger,
    messages,
    hooks,
    bridges,
    trail,
    detection,
    output,
    input,
    handoff,
    reads,
    reporter,
    revival,
    spawns,
    forgetter,
    catalog,
    restorer,
  };
}
