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
  AdapterEvent,
  DeclaredScope,
  PublishedRecord,
  SessionDescriptor,
  SessionLifecycle,
  SessionState,
} from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetStore } from '@atc/store';
import { match } from 'ts-pattern';
import { AuthSetup } from './auth-setup';
import type { AuthRebound } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { buildSessionLifecycle } from './build-session-lifecycle';
import { HostDirClaims } from './host-dir-claims';
import type { BridgeBinding } from './is-binding-current';
import { mintSessionID } from './mint-session-id';
import { pickSessionState } from './pick-session-state';
import type { PublishedRecords } from './published-records';
import type { RuntimeAuthBinder } from './runtime-auth-binder';
import type { Session } from './session';
import { SessionAdopter } from './session-adopter';
import type { MessageBridgeLaunch, SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionEventKind } from './session-event-kind';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import type { TargetBinding } from './session-registry';
import { SessionRestorer } from './session-restorer';
import { SessionSpawner } from './session-spawner';
import type { SpawnMaterializer } from './session-spawner';
import { SpawnRollback } from './spawn-rollback';

// The command that resumes a session outside atc, or why there is none: no
// such session, or a session that cannot resume outside atc.
export type ResumeCommand =
  | { readonly command: string }
  | { readonly refusal: 'missing' }
  | { readonly refusal: 'unsupported'; readonly reason: string };

/**
 * The callbacks a manager takes when it is built. Each one left out does
 * nothing, and a manager with no message bridge starts every session
 * without one.
 */
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

/**
 * The daemon's sessions, and every operation on them: it wires the session
 * modules together over one registry and one set of callbacks. It takes its
 * callbacks when it is built, so no session event arrives before its
 * handler exists, and the daemon sets its settings after it is built.
 */
export class SessionManager {
  readonly onOutput: (s: Session, data: string) => void;

  readonly onChange: () => void;

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  readonly onBoot: (s: Session, cols: number, rows: number) => void;

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;

  readonly onEvent: (kind: SessionEventKind, s: Session) => void;

  // Called when a session's process is known to have ended: it exited or
  // it was killed. A host that lost the connection or went to sleep may
  // still run the process, so neither calls it.
  readonly onProcessEnded: (s: Session) => void;

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

  private readonly store: FleetStore;

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
      getAuthBinder: () => this.authBinder,
      getRecords: () => this.records,
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

  set failedSpawnExitWaitMs(ms: number) {
    this.rollback.failedSpawnExitWaitMs = ms;
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

  findProvider(s: Session): ExecutionProvider | null {
    return this.registry.findProvider(s);
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

  updateRestoreRefusal(s: Session, reason: string, code: string | null): void {
    this.restorer.updateRestoreRefusal(s, reason, code);
  }

  updateRestoredIdentity(s: Session, identity: string): void {
    this.restorer.updateRestoredIdentity(s, identity);
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
    answer: ((s: Session) => void) | null = null,
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

  pickKillCapability(s: Session): ExecutionCapability {
    return this.killer.pickKillCapability(s);
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
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.agentSessionID === undefined) {
      return null;
    }

    const pty = s.pty;

    s.pty = null;
    s.kind = 'headless';
    s.state = 'running';
    s.lastMsg = 'ejected to headless';

    pty.kill();
    this.onEvent('state', s);
    this.fleet.emitChange();

    return s;
  }

  // Adds a checked scope to a session's published record and returns the
  // record as it stands after. The checks run on the session's host, so a
  // remote host that is not awake refuses the change until a revive wakes
  // it.
  async updateScope(id: SessionID, scope: DeclaredScope): Promise<PublishedRecord | 'missing'> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    if (this.records === null) {
      throw new DaemonError('unsupported', 'this daemon publishes no session records');
    }

    const provider = this.registry.requireExecution(s, 'spawn').provider;

    if (provider.remote && s.vm !== 'awake') {
      throw new DaemonError(
        'host_unavailable',
        `the host of session ${id} is not awake; revive the session before adding to its scope`,
        { provider: provider.kind, problem: 'host_asleep', host: s.hostKey },
      );
    }

    const subject = {
      session: s.id,
      target: s.target,
      provider,
      host: s.hostKey,
      dir: s.cwd,
      workspace: s.workspace ?? null,
    };

    const record = await this.records.updateScope(subject, scope);

    return record;
  }

  /**
   * Renames and/or pins a session on a caller's behalf. A rename lands at
   * user strength, so auto-summaries stop overwriting it while an
   * in-session rename still wins. Pinned sessions lead the TUI's list. A
   * sub-session inherits its parent's pin, and a pin of its own guards it
   * from its parent's forget too. A null parent makes a sub-session
   * top-level before any pin applies, so its pin, kill, and forget no
   * longer follow its former parent. A sub-session that runs in its
   * parent's host is refused a detach and a pin of its own, since the host
   * owner's kill and forget would still end it. A rename of a session the
   * agent named itself is skipped and returns 'agent_named', after any
   * other change applies.
   */
  updateSession(id: SessionID, changes: SessionChanges): boolean | 'shared_host' | 'agent_named' {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    if (
      s.parent !== null &&
      s.hostKey !== s.id &&
      (changes.parent === null || changes.pinned === true)
    ) {
      return 'shared_host';
    }

    if (changes.parent === null && s.parent !== null) {
      s.parent = null;

      this.onEvent('state', s);
    }

    const renameSkipped =
      changes.name !== undefined && changes.name !== '' && s.namedBy === 'agent';

    if (changes.name !== undefined && changes.name !== '' && !renameSkipped) {
      s.name = changes.name;
      s.namedBy = 'user';

      this.onEvent('renamed', s);
    }

    if (changes.pinned !== undefined && changes.pinned !== s.pinned) {
      s.pinned = changes.pinned;

      this.onEvent('state', s);
    }

    void this.fleet.tryWriteFleet(s.id);
    this.fleet.writeStatus();
    this.fleet.emitChange();

    return renameSkipped ? 'agent_named' : true;
  }

  // A result, when given, becomes the session's latest result the way a
  // terminal turn's final message does.
  updateSurfaceState(id: SessionID, state: SessionState, msg: string, result?: string) {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s || s.kind !== 'headless') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;
    s.unread = this.registry.focusedId !== s.id;

    if (result !== undefined) {
      s.result = truncateToBytes(result, 16_384);
      s.lastDetail = truncateDetail(result);
      void this.fleet.tryUpdateFleetEntry(s.id, { result: s.result });
    }

    this.onEvent('state', s);
    this.fleet.emitChange();
  }

  // The detector-stack screen tier reports through here: only flips between
  // running and needs_you — hook-driven done/exited states always win.
  updateAttention(id: SessionID, state: 'needs_you' | 'running', msg: string) {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.state === state) {
      return;
    }

    if (s.state !== 'running' && s.state !== 'needs_you') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;

    if (state === 'needs_you') {
      s.unread = this.registry.focusedId !== s.id;
    }

    this.onEvent('state', s);
    this.fleet.emitChange();
  }

  get focused(): Session | null {
    return this.registry.sessions.find((s) => s.id === this.registry.focusedId) ?? null;
  }

  collectDescriptors(): SessionDescriptor[] {
    return this.registry.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: pickSessionState(buildLifecycle(s), s.state),
      unread: s.unread,
      lastMsg: s.lastMsg,
      ...(s.lastDetail === undefined ? {} : { lastDetail: s.lastDetail }),
      ...(s.pty === null && s.restoreRefusal?.message === s.lastMsg
        ? { restoreRefusal: s.restoreRefusal.code }
        : {}),
      ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
      agent: s.agent,
      pinned: s.pinned,
      lastAttachedAt: s.lastAttachedAt,
      repoRoot: s.repoRoot,
      namedBy: s.namedBy,
      createdAt: s.createdAt,
      kind: s.kind,
      alive: s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'),
      canEject: (this.registry.findAdapter(s.agent)?.headlessRunner ?? null) !== null,
      ...(s.parent === null ? {} : { parent: s.parent }),
      locator: { daemonID: this.store.daemonID, targetID: s.target },
      ...(s.workspace === undefined ? {} : { workspace: s.workspace }),
      lifecycle: buildLifecycle(s),
      ...(s.model === undefined ? {} : { model: s.model }),
    }));
  }

  // Applies one hook line to its session: the adapter plans the line's
  // events from the state it returned for the session's previous line, and
  // the session takes each event in order. Returns the plan, so the caller
  // can key lifecycle bookkeeping and the event trail on its events and
  // keep its next state, or null when no session or adapter matches.
  applyHook(e: HookEvent, prev?: unknown): HookPlan | null {
    const s = this.registry.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return null;
    }

    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const plan = adapter.planHookEvents(e, prev);

    for (const ev of plan.events) {
      this.applyAdapterEvent(s, ev);
    }

    return plan;
  }

  private applyAdapterEvent(s: Session, ev: Readonly<AdapterEvent>): void {
    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (s.kind === 'headless') {
      return;
    }

    const focused = this.registry.focusedId === s.id;
    let dirty = false;
    let persist = false;
    const rowUpdate: { result?: string; transcriptPath?: string } = {};

    if (ev.transcriptSource !== undefined) {
      s.transcriptSource = ev.transcriptSource;

      if (s.transcriptPath !== ev.transcriptSource) {
        s.transcriptPath = ev.transcriptSource;
        rowUpdate.transcriptPath = ev.transcriptSource;
      }
    }

    if (ev.agentSessionID !== undefined && s.agentSessionID !== ev.agentSessionID) {
      s.agentSessionID = ev.agentSessionID;
      persist = true;
      dirty = true;
    }

    if (ev.detail !== undefined) {
      s.lastDetail = ev.detail;
    }

    if (ev.nameSource !== undefined) {
      void this.refreshName(s, ev.nameSource);
    }

    // A permission prompt stays pending until an event shows it closed: a
    // prompt, a finished turn, a start, an end, or an idle notice. A heartbeat
    // or a notice that says nothing about the prompt leaves it pending.
    if (ev.kind === 'needs-input') {
      s.permissionPending = ev.permissionPending ?? s.permissionPending === true;
    } else if (ev.kind !== 'heartbeat') {
      s.permissionPending = false;
    }

    // Each event kind returns whether it changed what the session lists.
    const changed = match(ev.kind)
      .with('started', () => {
        // Clearing or resuming inside a live terminal ends the old agent
        // session and starts a new one in the same process, so the start
        // supersedes the end's message. A gone terminal keeps it.
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';

          return true;
        }

        if (s.lastMsg === 'session ended' && s.pty !== null) {
          s.lastMsg = 'started';

          return true;
        }

        return false;
      })
      .with('needs-input', () => {
        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = ev.message ?? 'needs input';

        return true;
      })
      .with('turn-done', () => {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';

        if (ev.result !== undefined) {
          // A runaway final message cannot bloat the fleet row.
          s.result = truncateToBytes(ev.result, 16_384);
          rowUpdate.result = s.result;
        }

        return true;
      })
      .with('prompt-submitted', () => {
        s.state = 'running';
        s.unread = false;
        s.lastMsg = ev.message ?? 'working';

        return true;
      })

      // A live terminal can report an end without dying — resuming claude
      // closes the superseded session while its process stays interactive.
      // Exited is reserved for a gone terminal; onExit owns that transition.
      .with('ended', () => {
        if (s.pty === null) {
          s.state = 'exited';
        }

        s.unread = false;
        s.lastMsg = 'session ended';

        return true;
      })

      // Heartbeats only matter for the agent-session-id capture above.
      .with('heartbeat', () => false)
      .exhaustive();

    dirty ||= changed;

    // A fleet rewrite marks every session without a PTY as exited, so only a
    // new agent session id takes it. Anything else touches this session's
    // own row.
    if (persist) {
      void this.fleet.tryWriteFleet(s.id);
    } else {
      void this.fleet.tryUpdateFleetEntry(s.id, rowUpdate);
    }

    if (dirty) {
      this.onEvent('state', s);
      this.fleet.emitChange();
    }
  }

  private async refreshName(s: Session, source: string) {
    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      return;
    }

    const update = await adapter.loadName(source, s.namedBy);

    if (update === null || update.name === '' || update.name === s.name) {
      return;
    }

    s.name = update.name;

    if (update.namedBy !== undefined) {
      s.namedBy = update.namedBy;
    }

    void this.fleet.tryWriteFleet(s.id);
    this.onEvent('renamed', s);
    this.fleet.emitChange();
  }

  // Shell command that re-opens this session outside atc, on the daemon's
  // machine. A session on another machine has none: its folder, and any
  // settings file the command would pass, sit on a different machine than
  // the one the command would run on. An agent whose adapter builds no
  // command, such as a gateway that signs in through impd's broker alone,
  // has none either.
  buildResumeCommand(id: SessionID): ResumeCommand {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s) {
      return { refusal: 'missing' };
    }

    if (!this.registry.isLocalTarget(s.target)) {
      return {
        refusal: 'unsupported',
        reason: `session '${id}' runs on target '${s.target}', so it cannot resume outside atc on this machine`,
      };
    }

    const command =
      this.registry.findAdapter(s.agent)?.buildResumeCommand(s.cwd, s.agentSessionID) ?? null;

    if (command === null) {
      return {
        refusal: 'unsupported',
        reason: `agent '${s.agent}' of session '${id}' cannot resume outside atc`,
      };
    }

    return { command };
  }

  attach(id: SessionID) {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    s.unread = false;
    s.lastAttachedAt = this.clock.now();
    void this.fleet.tryWriteFleet(s.id);

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (s.state === 'needs_you') {
      s.state = 'running';
      s.lastMsg = 'attached';
    }

    this.onEvent('state', s);
    this.fleet.emitChange();
  }

  ack(id: SessionID) {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;

      this.onEvent('state', s);
    }

    this.fleet.emitChange();
  }

  // Lets go of every harness as the daemon stops: one on the daemon's own
  // machine ends with it, and one on a remote host runs on for the next
  // daemon to attach.
  detachAll() {
    for (const s of this.registry.sessions) {
      s.pty?.detach();
    }
  }

  // A harness detaches once, so a disposal after a detach of every harness
  // lets go of nothing again.
  [Symbol.dispose]() {
    this.detachAll();
  }
}

function buildLifecycle(s: Session): SessionLifecycle {
  return buildSessionLifecycle({
    desired: s.desired,
    vm: s.vm,
    attachment: s.attachment,
    suspended: s.suspended,
    hasHarness: s.pty !== null,
    kind: s.kind,
    state: s.state,
  });
}
