import { join } from 'node:path';
import type { InvalidGitTransports, TargetConfigError } from '@atc/config';
import { parseRestoreBootTimeoutMs } from '@atc/config';
import type { Clock, SessionID } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import { createRuntimeAuthBinder } from './auth/create-runtime-auth-binder';
import type { RuntimeAuthBinder } from './auth/create-runtime-auth-binder';
import { tryReconcileAuthBindings } from './auth/try-reconcile-auth-bindings';
import type { TapClient } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import { createFleetRestorer } from './fleet/create-fleet-restorer';
import type { FleetRestorer } from './fleet/create-fleet-restorer';
import { ConfirmTokens } from './sessions/confirm-tokens';
import { HookIntake } from './sessions/hook-intake';
import { startHookServer } from './sessions/hooks';
import type { HookScope } from './sessions/make-hook-runner';
import { MENU_TIMING } from './sessions/menu-terminal';
import { MessageBridges } from './sessions/message-bridges';
import { MessageService } from './sessions/message-service';
import { PublishedRecords } from './sessions/published-records';
import { ScreenDetection } from './sessions/screen-detection';
import { SessionForgetter } from './sessions/session-forgetter';
import { SessionHandoff } from './sessions/session-handoff';
import { SessionInput } from './sessions/session-input';
import { SessionOutput } from './sessions/session-output';
import { SessionReads } from './sessions/session-reads';
import type { SessionRuntime } from './sessions/session-runtime';
import type { SessionManager } from './sessions/sessions';
import { SpawnService } from './sessions/spawn-service';
import { startBridgeRevival } from './sessions/start-bridge-revival';
import type { BridgeRevival } from './sessions/start-bridge-revival';
import { startHeadlessTurn } from './sessions/start-headless-turn';
import type { TapRegistry } from './sessions/tap-registry';
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

  const records = new PublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(stateDir, 'records'),
    ghBin: opts.ghBin ?? 'gh',
    now: () => clock.now(),
  });

  manager.records = records;

  const authBinder = createRuntimeAuthBinder(store, () => clock.now());

  manager.authBinder = authBinder;

  // Settled in the background, since it reaches impd: each binding a
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

  const messages = new MessageService({
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

  const hooks = new HookIntake({
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
    ...(opts.onNoteIgnored === undefined ? {} : { onNoteIgnored: opts.onNoteIgnored }),
    ...(opts.onLastUsedUnchanged === undefined
      ? {}
      : { onLastUsedUnchanged: opts.onLastUsedUnchanged }),
  });

  const bridges = new MessageBridges({
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

  const detection = new ScreenDetection({
    manager,
    clock,
    findRuntime,
    onDetectSkipped: opts.onDetectSkipped,
  });

  const output = new SessionOutput({
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
    startHeadlessTurn(
      manager,
      findRuntime,
      sessionID,
      prompt,
      (turnSessionID, ev) => {
        hooks.recordHeadlessTurnEvent(turnSessionID, ev);
      },
      opts.reporterSocketPath,
    );

  const input = new SessionInput({
    manager,
    clock,
    findRuntime,
    menuTiming: opts.menuTiming ?? MENU_TIMING,
    startHeadlessTurn: startTurn,
  });

  const handoff = new SessionHandoff({
    manager,
    findRuntime,
    ejectSettleMs: opts.ejectSettleMs ?? 4000,
    scheduleEjectSettle: opts.scheduleEjectSettle ?? clock.schedule,
    startHeadlessTurn: startTurn,
    scheduleResize: (sessionID) => {
      output.scheduleResize(sessionID);
    },
  });

  const reads = new SessionReads({ manager, store, records });

  const reporter = startHookServer((hookEvent) => {
    hooks.applyHookEvent(hookEvent);
  }, opts.reporterSocketPath);

  const spawns = new SpawnService({
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

  const forgetter = new SessionForgetter({
    manager,
    findRuntime,
    tokens: new ConfirmTokens({
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
