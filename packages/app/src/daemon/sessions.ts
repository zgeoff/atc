import type { TargetConfigError } from '@atc/config/collect-targets';
import { statusFile } from '@atc/config/config';
import { LOCAL_TARGET } from '@atc/config/local-target';
import type { SessionID } from '@atc/core/session-id';
import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { truncateDetail } from '@atc/core/truncate-detail';
import { truncateToBytes } from '@atc/core/truncate-to-bytes';
import { LocalPTYProvider } from '@atc/execution-local/local-pty-provider';
import type { AgentAdapter, HookPlan } from '@atc/plugin-api/agent-adapter';
import type { HarnessRelay } from '@atc/plugin-api/execution-provider';
import type { AdapterEvent } from '@atc/protocol/adapter-event';
import { DaemonError } from '@atc/protocol/daemon-error';
import type { HookEvent } from '@atc/protocol/hook-event';
import type { DeclaredScope } from '@atc/protocol/parse-declared-scope';
import type { PublishedRecord } from '@atc/protocol/published-record';
import type { SessionDescriptor } from '@atc/protocol/session-descriptor';
import type { SessionLifecycle } from '@atc/protocol/session-lifecycle';
import type { SessionState } from '@atc/protocol/session-state';
import type { FleetStore } from '@atc/store/fleet-entry';
import { match } from 'ts-pattern';
import { AuthSetup } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { buildSessionLifecycle } from './build-session-lifecycle';
import { HostDirClaims } from './host-dir-claims';
import type { BridgeBinding } from './is-binding-current';
import { pickSessionState } from './pick-session-state';
import type { PublishedRecords } from './published-records';
import type { RuntimeAuthBinder } from './runtime-auth-binder';
import type { Session } from './session';
import { SessionAdopter } from './session-adopter';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionEventKind } from './session-event-kind';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionKiller } from './session-killer';
import { LOCAL_TARGET_IDENTITY, SessionRegistry } from './session-registry';
import { SessionRestorer } from './session-restorer';
import { SessionSpawner } from './session-spawner';
import { SpawnRollback } from './spawn-rollback';

// The command that resumes a session outside atc, or why there is none: no
// such session, or a session that cannot resume outside atc.
export type ResumeCommand =
  | { readonly command: string }
  | { readonly refusal: 'missing' }
  | { readonly refusal: 'unsupported'; readonly reason: string };

/**
 * The daemon's sessions, and every operation on them: it wires the session
 * modules together over one registry and one set of callbacks, and the
 * daemon sets its callbacks and settings after it is built.
 */
export class SessionManager {
  onOutput: (s: Session, data: string) => void = () => {};

  onChange: () => void = () => {};

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  onBoot: (s: Session, cols: number, rows: number) => void = () => {};

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void = () => {};

  onEvent: (kind: SessionEventKind, s: Session) => void = () => {};

  // Called when a session's process is known to have ended: it exited or
  // it was killed. A host that lost the connection or went to sleep may
  // still run the process, so neither calls it.
  onProcessEnded: (s: Session) => void = () => {};

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

  private readonly claims: HostDirClaims;

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
    targets: readonly ExecutionTarget[] = [
      {
        id: LOCAL_TARGET.id,
        kind: LOCAL_TARGET.provider,
        options: LOCAL_TARGET.options,
        identity: LOCAL_TARGET_IDENTITY,
        provider: new LocalPTYProvider(),
      },
    ],
    targetErrors: readonly TargetConfigError[] = [],
  ) {
    // Each module reads the daemon's callbacks and settings at the moment
    // it acts, since the daemon sets them after the manager is built.
    const callbacks: SessionCallbacks = {
      onOutput: (s, data) => {
        this.onOutput(s, data);
      },
      onChange: () => {
        this.onChange();
      },
      onBoot: (s, cols, rows) => {
        this.onBoot(s, cols, rows);
      },
      onRelay: (binding, relay) => {
        this.onRelay(binding, relay);
      },
      onEvent: (kind, s) => {
        this.onEvent(kind, s);
      },
      onProcessEnded: (s) => {
        this.onProcessEnded(s);
      },
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
    const killer = new SessionKiller({ registry, fleet, callbacks });
    const harnesses = new SessionHarnesses({ registry, fleet, killer, callbacks });
    const rollback = new SpawnRollback({ registry, fleet, claims, harnesses, callbacks });
    const auth = new AuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });

    this.store = store;
    this.registry = registry;
    this.fleet = fleet;
    this.claims = claims;
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
    ...args: Parameters<SessionRegistry['requireExecution']>
  ): ReturnType<SessionRegistry['requireExecution']> {
    return this.registry.requireExecution(...args);
  }

  findExecutionRefusal(
    ...args: Parameters<SessionRegistry['findExecutionRefusal']>
  ): ReturnType<SessionRegistry['findExecutionRefusal']> {
    return this.registry.findExecutionRefusal(...args);
  }

  findProvider(
    ...args: Parameters<SessionRegistry['findProvider']>
  ): ReturnType<SessionRegistry['findProvider']> {
    return this.registry.findProvider(...args);
  }

  findAdapter(
    ...args: Parameters<SessionRegistry['findAdapter']>
  ): ReturnType<SessionRegistry['findAdapter']> {
    return this.registry.findAdapter(...args);
  }

  collectAdapters(
    ...args: Parameters<SessionRegistry['collectAdapters']>
  ): ReturnType<SessionRegistry['collectAdapters']> {
    return this.registry.collectAdapters(...args);
  }

  isLocalTarget(
    ...args: Parameters<SessionRegistry['isLocalTarget']>
  ): ReturnType<SessionRegistry['isLocalTarget']> {
    return this.registry.isLocalTarget(...args);
  }

  isCallerTree(
    ...args: Parameters<SessionRegistry['isCallerTree']>
  ): ReturnType<SessionRegistry['isCallerTree']> {
    return this.registry.isCallerTree(...args);
  }

  collectChildren(
    ...args: Parameters<SessionRegistry['collectChildren']>
  ): ReturnType<SessionRegistry['collectChildren']> {
    return this.registry.collectChildren(...args);
  }

  countStates(
    ...args: Parameters<SessionRegistry['countStates']>
  ): ReturnType<SessionRegistry['countStates']> {
    return this.registry.countStates(...args);
  }

  sortSessions(
    ...args: Parameters<SessionRegistry['sortSessions']>
  ): ReturnType<SessionRegistry['sortSessions']> {
    return this.registry.sortSessions(...args);
  }

  resolveRestoredEntry(
    ...args: Parameters<SessionRestorer['resolveRestoredEntry']>
  ): ReturnType<SessionRestorer['resolveRestoredEntry']> {
    return this.restorer.resolveRestoredEntry(...args);
  }

  restore(...args: Parameters<SessionRestorer['restore']>): ReturnType<SessionRestorer['restore']> {
    return this.restorer.restore(...args);
  }

  isUnrestored(
    ...args: Parameters<SessionRestorer['isUnrestored']>
  ): ReturnType<SessionRestorer['isUnrestored']> {
    return this.restorer.isUnrestored(...args);
  }

  removeUnrestoredMark(
    ...args: Parameters<SessionRestorer['removeUnrestoredMark']>
  ): ReturnType<SessionRestorer['removeUnrestoredMark']> {
    return this.restorer.removeUnrestoredMark(...args);
  }

  updateRestoreRefusal(
    ...args: Parameters<SessionRestorer['updateRestoreRefusal']>
  ): ReturnType<SessionRestorer['updateRestoreRefusal']> {
    return this.restorer.updateRestoreRefusal(...args);
  }

  updateRestoredIdentity(
    ...args: Parameters<SessionRestorer['updateRestoredIdentity']>
  ): ReturnType<SessionRestorer['updateRestoredIdentity']> {
    return this.restorer.updateRestoredIdentity(...args);
  }

  requireAgentTarget(
    ...args: Parameters<AuthSetup['requireAgentTarget']>
  ): ReturnType<AuthSetup['requireAgentTarget']> {
    return this.auth.requireAgentTarget(...args);
  }

  revokeAuth(...args: Parameters<AuthSetup['revokeAuth']>): ReturnType<AuthSetup['revokeAuth']> {
    return this.auth.revokeAuth(...args);
  }

  updateAuth(...args: Parameters<AuthSetup['updateAuth']>): ReturnType<AuthSetup['updateAuth']> {
    return this.auth.updateAuth(...args);
  }

  adoptTerminal(
    ...args: Parameters<SessionAdopter['adoptTerminal']>
  ): ReturnType<SessionAdopter['adoptTerminal']> {
    return this.adopter.adoptTerminal(...args);
  }

  spawn(...args: Parameters<SessionSpawner['spawn']>): ReturnType<SessionSpawner['spawn']> {
    return this.spawner.spawn(...args);
  }

  releaseWorkspace(
    ...args: Parameters<HostDirClaims['releaseWorkspace']>
  ): ReturnType<HostDirClaims['releaseWorkspace']> {
    return this.claims.releaseWorkspace(...args);
  }

  removeFailedSpawn(
    ...args: Parameters<SpawnRollback['removeFailedSpawn']>
  ): ReturnType<SpawnRollback['removeFailedSpawn']> {
    return this.rollback.removeFailedSpawn(...args);
  }

  kill(...args: Parameters<SessionKiller['kill']>): ReturnType<SessionKiller['kill']> {
    return this.killer.kill(...args);
  }

  forget(...args: Parameters<SessionKiller['forget']>): ReturnType<SessionKiller['forget']> {
    return this.killer.forget(...args);
  }

  pickKillCapability(
    ...args: Parameters<SessionKiller['pickKillCapability']>
  ): ReturnType<SessionKiller['pickKillCapability']> {
    return this.killer.pickKillCapability(...args);
  }

  writeStatus(
    ...args: Parameters<SessionFleetWriter['writeStatus']>
  ): ReturnType<SessionFleetWriter['writeStatus']> {
    return this.fleet.writeStatus(...args);
  }

  writeFleet(
    ...args: Parameters<SessionFleetWriter['writeFleet']>
  ): ReturnType<SessionFleetWriter['writeFleet']> {
    return this.fleet.writeFleet(...args);
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
   * in-session rename still wins. Pinned sessions lead every list. A
   * sub-session takes its pin from its parent, so pinning one is refused.
   * A null parent makes a sub-session top-level before any pin applies, so
   * its pin, kill, and forget no longer follow its former parent. A
   * sub-session that runs in its parent's host is refused one, since the
   * host owner's kill and forget would still end it. A rename of a session
   * the agent named itself is skipped and returns 'agent_named', after any
   * other change applies.
   */
  updateSession(
    id: SessionID,
    changes: SessionChanges,
  ): boolean | 'child_pin' | 'shared_host' | 'agent_named' {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    if (changes.parent === null && s.parent !== null && s.hostKey !== s.id) {
      return 'shared_host';
    }

    if (changes.pinned !== undefined && s.parent !== null && changes.parent !== null) {
      return 'child_pin';
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
