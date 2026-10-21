import type { TargetConfigError } from '@atc/config';
import { statusFile } from '@atc/config';
import type { AgentID, AgentSessionID, Clock, SessionID } from '@atc/core';
import { systemClock, truncateDetail, truncateToBytes } from '@atc/core';
import type {
  AgentAdapter,
  ExecutionCapability,
  ExecutionProvider,
  HarnessRelay,
  HookPlan,
  SpawnOverrides,
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
import { AuthSetup } from '../auth/auth-setup';
import type { AuthRebound } from '../auth/auth-setup';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { RuntimeAuthBinder } from '../auth/runtime-auth-binder';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { SessionFleetWriter } from '../fleet/session-fleet-writer';
import { SessionRestorer } from '../fleet/session-restorer';
import { collectSessionDescriptors } from './collect-session-descriptors';
import { HostDirClaims } from './host-dir-claims';
import { mintSessionID } from './mint-session-id';
import { planResumeCommand } from './plan-resume-command';
import type { ResumeCommand } from './plan-resume-command';
import type { PublishedRecords } from './published-records';
import type { Session } from './session';
import { SessionAdopter } from './session-adopter';
import type { MessageBridgeLaunch, SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionEventKind } from './session-event-kind';
import { SessionHarnesses } from './session-harnesses';
import { SessionHookApplier } from './session-hook-applier';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import type { TargetBinding } from './session-registry';
import { SessionSpawner } from './session-spawner';
import type { SpawnMaterializer } from './spawn-materializer';
import { SpawnRollback } from './spawn-rollback';
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

export class SessionManager {
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
  log: (line: string) => void = (line) => {
    console.error(line);
  };

  // The clock each remote launch's step timing reads, in milliseconds.
  now: () => number = () => performance.now();

  // The clock a session's creation and last attach are stamped with.
  clock: Clock = systemClock;

  // Binds the runtime auth of each host whose agent takes its credential
  // from impd's broker; with none, every such start is refused.
  authBinder: RuntimeAuthBinder | null = null;

  // Publishes each session's record before its harness starts; with none,
  // sessions start without a record.
  records: PublishedRecords | null = null;

  private readonly registry: SessionRegistry;

  private readonly fleet: SessionFleetWriter;

  private readonly killer: SessionKiller;

  private readonly rollback: SpawnRollback;

  private readonly auth: AuthSetup;

  private readonly restorer: SessionRestorer;

  private readonly adopter: SessionAdopter;

  private readonly spawner: SessionSpawner;

  private readonly hooks: SessionHookApplier;

  private readonly callbacks: SessionCallbacks;

  private readonly store: FleetStore;

  // events are taken at build time, so no session event arrives before its
  // handler exists
  constructor(
    fallback: AgentAdapter | null | undefined,
    store: FleetStore,
    statusPath: string | undefined = statusFile,
    adapters: readonly AgentAdapter[] = [],
    targets: readonly ExecutionTarget[] = [],
    targetErrors: readonly TargetConfigError[] = [],
    events: SessionManagerEvents = {},
  ) {
    this.onOutput = events.onOutput ?? (() => {});
    this.onChange = events.onChange ?? (() => {});
    this.onBoot = events.onBoot ?? (() => {});
    this.onRelay = events.onRelay ?? (() => {});
    this.onEvent = events.onEvent ?? (() => {});
    this.onProcessEnded = events.onProcessEnded ?? (() => {});
    this.startMessageBridge = events.startMessageBridge ?? (() => Promise.resolve(null));
    this.stopMessageBridge = events.stopMessageBridge ?? (() => Promise.resolve());

    // Each module reads the daemon's settings at the moment it acts, since
    // the daemon sets them after the manager is built.
    const callbacks: SessionCallbacks = {
      onOutput: this.onOutput,
      onChange: this.onChange,
      onBoot: this.onBoot,
      onRelay: this.onRelay,
      onEvent: this.onEvent,
      onProcessEnded: this.onProcessEnded,
      startMessageBridge: this.startMessageBridge,
      stopMessageBridge: this.stopMessageBridge,
      log: (line) => {
        this.log(line);
      },
      now: () => this.now(),
      getClock: () => this.clock,
      findAuthBinder: () => this.authBinder,
      findRecords: () => this.records,
    };

    const registry = new SessionRegistry({ fallback, adapters, targets, targetErrors, callbacks });

    const fleet = new SessionFleetWriter({
      registry,
      store,
      statusPath: statusPath ?? statusFile,
      callbacks,
    });

    const claims = new HostDirClaims({ registry });

    // The killer reaches the adopter, built after it, only once a kill runs.
    const restarts = { stopRestart: (id: SessionID) => this.adopter.stopRestart(id) };

    const killer = new SessionKiller({ registry, fleet, callbacks, restarts });
    const harnesses = new SessionHarnesses({ registry, fleet, killer, callbacks });
    const rollback = new SpawnRollback({ registry, fleet, claims, harnesses, callbacks });
    const auth = new AuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });

    this.callbacks = callbacks;
    this.store = store;
    this.registry = registry;
    this.fleet = fleet;
    this.killer = killer;
    this.rollback = rollback;
    this.auth = auth;

    this.restorer = new SessionRestorer({ registry, fleet, callbacks });
    this.adopter = new SessionAdopter({ registry, fleet, harnesses, rollback, auth, callbacks });

    this.spawner = new SessionSpawner({
      registry,
      fleet,
      claims,
      harnesses,
      rollback,
      auth,
      callbacks,
    });

    this.hooks = new SessionHookApplier({ registry, fleet, callbacks });
  }

  get sessions(): Session[] {
    return this.registry.sessions;
  }

  set sessions(sessions: Session[]) {
    this.registry.sessions = sessions;
  }

  get focusedId(): SessionID | null {
    return this.registry.focusedId;
  }

  set focusedId(id: SessionID | null) {
    this.registry.focusedId = id;
  }

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward.
  get hasScreenDetector(): boolean {
    return this.registry.hasScreenDetector;
  }

  // How long a failed spawn's rollback waits for the killed process to
  // exit, in milliseconds, once after its kill and once more after a forced
  // kill.
  get failedSpawnExitWaitMs(): number {
    return this.rollback.failedSpawnExitWaitMs;
  }

  set failedSpawnExitWaitMs(waitMs: number) {
    this.rollback.failedSpawnExitWaitMs = waitMs;
  }

  requireExecution(
    binding: Readonly<TargetBinding>,
    capability: ExecutionCapability,
  ): { readonly provider: ExecutionProvider; readonly identity: string } {
    return this.registry.requireExecution(binding, capability);
  }

  findExecutionRefusal(
    binding: Readonly<{ target: string | null; targetIdentity: string | null }>,
    capability: ExecutionCapability,
  ): DaemonError | null {
    return this.registry.findExecutionRefusal(binding, capability);
  }

  findProvider(session: Session): ExecutionProvider | null {
    return this.registry.findProvider(session);
  }

  findAdapter(id: AgentID): AgentAdapter | null {
    return this.registry.findAdapter(id);
  }

  collectAdapters(): AgentAdapter[] {
    return this.registry.collectAdapters();
  }

  isLocalTarget(target: string): boolean {
    return this.registry.isLocalTarget(target);
  }

  isCallerTree(id: SessionID, caller: SessionID): boolean {
    return this.registry.isCallerTree(id, caller);
  }

  collectChildren(id: SessionID): Session[] {
    return this.registry.collectChildren(id);
  }

  countStates(): ReturnType<SessionRegistry['countStates']> {
    return this.registry.countStates();
  }

  sortSessions(): Session[] {
    return this.registry.sortSessions();
  }

  resolveRestoredEntry(entry: FleetEntry): Promise<FleetEntry> {
    return this.restorer.resolveRestoredEntry(entry);
  }

  restore(entry: FleetEntry): Session {
    return this.restorer.restore(entry);
  }

  isUnrestored(id: SessionID): boolean {
    return this.restorer.isUnrestored(id);
  }

  removeUnrestoredMark(id: SessionID): void {
    this.restorer.removeUnrestoredMark(id);
  }

  updateRestoreRefusal(session: Session, reason: string, code: string | null): void {
    this.restorer.updateRestoreRefusal(session, reason, code);
  }

  updateRestoredIdentity(session: Session, identity: string): void {
    this.restorer.updateRestoredIdentity(session, identity);
  }

  requireAgentTarget(agent: AgentID, target: string): void {
    this.auth.requireAgentTarget(agent, target);
  }

  revokeAuth(id: SessionID): Promise<boolean> {
    return this.auth.revokeAuth(id);
  }

  updateAuth(id: SessionID): Promise<AuthRebound | null> {
    return this.auth.updateAuth(id);
  }

  adoptTerminal(
    id: SessionID,
    cols: number,
    rows: number,
    canProceed: () => boolean = () => true,
  ): Promise<Session | null> {
    return this.adopter.adoptTerminal(id, cols, rows, canProceed);
  }

  spawn(
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume: boolean | AgentSessionID = false,
    namedBy: 'user' | 'auto' = 'auto',
    agent: AgentID = 'claude',
    parent: SessionID | null = null,
    overrides: SpawnOverrides = {},
    id: SessionID = mintSessionID(),
    target = 'local',
    materialize: SpawnMaterializer | null = null,
    requireInReach: () => void = () => {},
    autoDir = false,
    scope: DeclaredScope | null = null,
    answer: ((session: Session) => void) | null = null,
  ): Promise<Session> {
    return this.spawner.spawn(
      cwd,
      name,
      prompt,
      cols,
      rows,
      resume,
      namedBy,
      agent,
      parent,
      overrides,
      id,
      target,
      materialize,
      requireInReach,
      autoDir,
      scope,
      answer,
    );
  }

  kill(id: SessionID, stopOnly = false): Promise<'stopped' | 'unchanged' | 'removed'> {
    return this.killer.kill(id, stopOnly);
  }

  forget(id: SessionID): Promise<boolean> {
    return this.killer.forget(id);
  }

  pickKillCapability(session: Session): ExecutionCapability {
    return this.killer.pickKillCapability(session);
  }

  writeStatus(): void {
    this.fleet.writeStatus();
  }

  writeFleet(): Promise<void> {
    return this.fleet.writeFleet();
  }

  // Hands a live terminal session off to a headless run: the terminal dies,
  // the record lives on as a headless session and keeps its screen history.
  yankHeadless(id: SessionID): Session | null {
    const session = this.registry.sessions.find((x) => x.id === id);

    if (!session || session.pty === null || session.agentSessionID === undefined) {
      return null;
    }

    const pty = session.pty;

    session.pty = null;
    session.kind = 'headless';
    session.state = 'running';
    session.lastMsg = 'ejected to headless';

    pty.kill();
    this.onEvent('state', session);
    this.fleet.emitChange();

    return session;
  }

  updateScope(id: SessionID, scope: DeclaredScope): Promise<PublishedRecord | 'missing'> {
    return updateSessionScope({ registry: this.registry, records: this.records }, id, scope);
  }

  updateSession(id: SessionID, changes: SessionChanges): boolean | 'shared_host' | 'agent_named' {
    return updateSession(
      { registry: this.registry, fleet: this.fleet, callbacks: this.callbacks },
      id,
      changes,
    );
  }

  // A result, when given, becomes the session's latest result the way a
  // terminal turn's final message does.
  updateSurfaceState(id: SessionID, state: SessionState, message: string, result?: string) {
    const session = this.registry.sessions.find((x) => x.id === id);

    if (!session || session.kind !== 'headless') {
      return;
    }

    session.state = state;
    session.lastMsg = message;
    session.unread = this.registry.focusedId !== session.id;

    if (result !== undefined) {
      session.result = truncateToBytes(result, 16_384);
      session.lastDetail = truncateDetail(result);
      void this.fleet.tryUpdateFleetEntry(session.id, { result: session.result });
    }

    this.onEvent('state', session);
    this.fleet.emitChange();
  }

  // The detector-stack screen tier reports through here: only flips between
  // running and needs_you — hook-driven done/exited states always win.
  updateAttention(id: SessionID, state: 'needs_you' | 'running', message: string) {
    const session = this.registry.sessions.find((x) => x.id === id);

    if (!session || session.pty === null || session.state === state) {
      return;
    }

    if (session.state !== 'running' && session.state !== 'needs_you') {
      return;
    }

    session.state = state;
    session.lastMsg = message;

    if (state === 'needs_you') {
      session.unread = this.registry.focusedId !== session.id;
    }

    this.onEvent('state', session);
    this.fleet.emitChange();
  }

  get focused(): Session | null {
    return this.registry.sessions.find((session) => session.id === this.registry.focusedId) ?? null;
  }

  collectDescriptors(): SessionDescriptor[] {
    return collectSessionDescriptors(this.registry, this.store);
  }

  applyHook(hookEvent: HookEvent, previous?: unknown): HookPlan | null {
    return this.hooks.applyHook(hookEvent, previous);
  }

  planResumeCommand(id: SessionID): ResumeCommand {
    return planResumeCommand(this.registry, id);
  }

  attach(id: SessionID) {
    const session = this.registry.sessions.find((x) => x.id === id);

    if (!session) {
      return;
    }

    session.unread = false;
    session.lastAttachedAt = this.clock.now();
    void this.fleet.tryWriteFleet(session.id);

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (session.state === 'needs_you') {
      session.state = 'running';
      session.lastMsg = 'attached';
    }

    this.onEvent('state', session);
    this.fleet.emitChange();
  }

  ack(id: SessionID) {
    const session = this.registry.sessions.find((x) => x.id === id);

    if (session) {
      session.unread = false;

      this.onEvent('state', session);
    }

    this.fleet.emitChange();
  }

  // Lets go of every harness as the daemon stops: one on the daemon's own
  // machine ends with it, and one on a remote host runs on for the next
  // daemon to attach.
  detachAll() {
    for (const session of this.registry.sessions) {
      session.pty?.detach();
    }
  }

  // A harness detaches once, so a disposal after a detach of every harness
  // lets go of nothing again.
  [Symbol.dispose]() {
    this.detachAll();
  }
}
