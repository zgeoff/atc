import { join } from 'node:path';
import type { InvalidGitTransports, TargetConfigError } from '@atc/config';
import { parseRestoreBootTimeoutMs } from '@atc/config';
import type { Clock, SessionID } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import { RuntimeAuthBinder } from './auth/runtime-auth-binder';
import { tryReconcileAuthBindings } from './auth/try-reconcile-auth-bindings';
import type { TapClient } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import { FleetRestorer } from './fleet/fleet-restorer';
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
import { SpawnCatalog } from './sources/spawn-catalog';
import type { EventSignal } from './transport/event-signal';
import { EventTrail } from './transport/event-trail';
import { IdempotencyLedger } from './transport/idempotency-ledger';

export interface SessionServicesDeps {
  readonly opts: DaemonOptions;
  readonly mgr: SessionManager;
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
  const mgr = deps.mgr;
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

  mgr.records = records;

  const authBinder = new RuntimeAuthBinder(store, () => clock.now());

  mgr.authBinder = authBinder;

  // Settled in the background, since it reaches impd: each binding a
  // stopped daemon left mid-change stays blocked until it is settled.
  void tryReconcileAuthBindings(authBinder, store, targetsByID, mgr.log);

  const ledger = new IdempotencyLedger(
    store,
    LOCAL_PRINCIPAL,
    (line) => {
      mgr.log(line);
    },
    clock,
  );

  const messages = new MessageService({
    mgr,
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
    mgr,
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
    mgr,
    store,
    clock,
    messages,
    taps,
    applyNote: (e) => hooks.applyNote(e),
    stateDir,
  });

  const revival = startBridgeRevival({
    mgr,
    taps,
    clock,
    isProcessEnded: (sessionID) => endedProcesses.has(sessionID),
    applyNote: (e) => hooks.applyNote(e),
  });

  const trail = new EventTrail({ mgr, store, clock, eventSignal });

  const detection = new ScreenDetection({
    mgr,
    clock,
    findRuntime,
    onDetectSkipped: opts.onDetectSkipped,
  });

  const output = new SessionOutput({
    mgr,
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
      mgr,
      findRuntime,
      sessionID,
      prompt,
      (turnSessionID, ev) => {
        hooks.recordHeadlessTurnEvent(turnSessionID, ev);
      },
      opts.reporterSocketPath,
    );

  const input = new SessionInput({
    mgr,
    clock,
    findRuntime,
    menuTiming: opts.menuTiming ?? MENU_TIMING,
    startHeadlessTurn: startTurn,
  });

  const handoff = new SessionHandoff({
    mgr,
    findRuntime,
    ejectSettleMs: opts.ejectSettleMs ?? 4000,
    scheduleEjectSettle: opts.scheduleEjectSettle ?? clock.schedule,
    startHeadlessTurn: startTurn,
    scheduleResize: (sessionID) => {
      output.scheduleResize(sessionID);
    },
  });

  const reads = new SessionReads({ mgr, store, records });

  const reporter = startHookServer((e) => {
    hooks.applyHookEvent(e);
  }, opts.reporterSocketPath);

  const spawns = new SpawnService({
    mgr,
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
    mgr,
    findRuntime,
    tokens: new ConfirmTokens({
      now: opts.forgetClock ?? (() => clock.now()),
      lifetimeMs: opts.forgetConfirmMs ?? FORGET_CONFIRM_MS,
    }),
  });

  const catalog = new SpawnCatalog({
    mgr,
    store,
    build: opts.build,
    targets,
    defaultTarget,
    targetErrors,
    ...(opts.defaultAgent === undefined ? {} : { defaultAgent: opts.defaultAgent }),
    sources: opts.sources ?? [],
    gitTransports,
  });

  const restorer = new FleetRestorer({
    mgr,
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
