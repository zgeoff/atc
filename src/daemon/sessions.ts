import { writeFileSync } from 'node:fs';
import type {
  AdapterEvent,
  AgentAdapter,
  AgentID,
  SpawnOptions,
  SpawnOverrides,
  SpawnPlan,
} from '../agents/agent-adapter';
import { truncateDetail } from '../agents/truncate-detail';
import { DaemonError } from '../protocol/daemon-error';
import type { ErrorCode } from '../protocol/protocol';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { TargetConfigError } from '../shared/collect-targets';
import { socketPath, statusFile } from '../shared/config';
import type { DaemonID } from '../shared/daemon-id';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import type { SessionID } from '../shared/session-id';
import { truncateToBytes } from '../shared/truncate-to-bytes';
import type { FleetEntry, FleetEntryUpdate, FleetStore } from '../store/fleet-entry';
import type { SessionWorkspace } from '../store/workspace-materialization';
import type { ExecutionTarget } from './build-execution-targets';
import { buildSessionLifecycle } from './build-session-lifecycle';
import type { SessionLifecycle } from './build-session-lifecycle';
import { buildTarArchive } from './build-tar-archive';
import { buildTargetIdentity } from './build-target-identity';
import type {
  ExecutionCapability,
  ExecutionProvider,
  HarnessHandle,
  HarnessRelay,
} from './execution-provider';
import { findExecutionRefusal } from './find-execution-refusal';
import type { HookEvent } from './hooks';
import type { BridgeBinding } from './is-binding-current';
import { LocalPTYProvider } from './local-pty-provider';
import { mintSessionID } from './mint-session-id';
import { pickSessionState } from './pick-session-state';

export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export type SessionEventKind = 'added' | 'state' | 'renamed' | 'removed';

// The over-the-wire view of a session: everything but the harness handle,
// plus the surface kind.
export interface SessionDescriptor {
  readonly id: SessionID;
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
  readonly lastDetail?: string;
  readonly agentSessionID?: AgentSessionID;
  readonly agent: AgentID;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly repoRoot: string;
  readonly namedBy: 'user' | 'auto' | 'agent';
  readonly createdAt: number;
  readonly kind: 'pty' | 'headless';
  readonly alive: boolean;

  // Whether this session's agent can run a headless turn, so the client can
  // offer the eject action without knowing which agent it is.
  readonly canEject: boolean;

  // The session this one is a sub-session of, when it has one: it lists
  // under that session and takes its pin from it.
  readonly parent?: SessionID;

  // Where the session runs: the daemon hosting it, and the execution target
  // on that daemon's host.
  readonly locator: SessionLocator;

  // What the session's working directory was materialized from, for a
  // session spawned with a workspace source.
  readonly workspace?: SessionWorkspace;

  // What the operator asked for, the host, the harness, and the daemon's
  // connection to it; the state derives from these and the attention.
  readonly lifecycle: SessionLifecycle;
}

interface SessionLocator {
  readonly daemonID: DaemonID;
  readonly targetID: string;
}

export interface Session {
  id: SessionID;
  name: string;
  cwd: string;
  kind: 'pty' | 'headless';

  // The running harness its execution provider handed back, or null when
  // the session has no terminal.
  pty: HarnessHandle | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  lastDetail?: string;
  agentSessionID?: AgentSessionID;
  agent: AgentID;
  transcriptSource?: string;
  pinned: boolean;

  // when the operator last attached, so lists can lead with the sessions
  // they were just working in; starts at creation time.
  lastAttachedAt: number;

  // the repository this session's directory belongs to (the directory
  // itself outside any repository), for clustering in the overlay.
  repoRoot: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;

  // The session that spawned this one as a sub-session; null for a
  // top-level session. One level deep: a sub-session never owns another.
  parent: SessionID | null;

  // the prompt the session was spawned with
  prompt?: string;

  // the agent's final message from its latest finished turn, capped in size
  result?: string;

  // the transcript file the agent's hooks last reported. Kept apart from the
  // resume check so a restored path never changes whether a revive is allowed.
  transcriptPath?: string;

  // the model and effort the session was spawned with; absent leaves the
  // agent's configured default, and every revive passes them again.
  model?: string;
  effort?: string;

  // the execution target the session runs on, and the identity it had
  // when the session started there; every revive runs there too, and only
  // while the target keeps that identity.
  target: string;
  targetIdentity: string;

  // what the working directory was materialized from, when the spawn
  // carried a workspace source
  workspace?: SessionWorkspace;

  // the environment variable names every harness the session starts goes
  // without: the materialization's credential and askpass context
  withheldEnv: readonly string[];

  // What the operator asked of the harness, the last state seen of its
  // host, and the daemon's connection to its output.
  desired: SessionLifecycle['desired'];
  vm: SessionLifecycle['vm'];
  attachment: SessionLifecycle['attachment'];

  // Whether the harness is kept inside a sleeping host, for a revive to
  // find as it was.
  suspended: boolean;

  // The session whose host the harness runs on: its own id, or its
  // parent's when the parent runs on the same target, so one host serves a
  // top-level session and the sub-sessions beside it.
  hostKey: SessionID;

  // The epoch of the session's latest harness start or attach, which the
  // daemon's bridge to that harness is bound to; 0 before the first.
  bridgeEpoch: number;
}

// A session's ready workspace and the variables its harnesses go without.
interface MaterializedSpawn {
  readonly workspace: SessionWorkspace;
  readonly withheldEnv: readonly string[];
}

// The identity of the implicit `local` target, which a fleet row without a
// stored identity ran on.
const LOCAL_TARGET_IDENTITY = buildTargetIdentity('local-pty', {});

// How long a failed spawn's rollback waits for the killed process to exit
// before it leaves the spawn's outcome unknown.
const FAILED_SPAWN_EXIT_WAIT_MS = 2000;

// The target a session runs on and the identity it is bound to there; null
// binds a new session to the target as it stands now.
interface TargetBinding {
  readonly target: string;
  readonly targetIdentity: string | null;
}

export class SessionManager {
  sessions: Session[] = [];

  focusedId: SessionID | null = null;

  onOutput: (s: Session, data: string) => void = () => {};

  onChange: () => void = () => {};

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  onBoot: (s: Session, cols: number, rows: number) => void = () => {};

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void = () => {};

  onEvent: (kind: SessionEventKind, s: Session) => void = () => {};

  // Where a background failure is reported, one line at a time: stderr,
  // like the daemon's other background failures.
  log: (line: string) => void = (line) => {
    console.error(line);
  };

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward. Lets a hot path
  // that only cares about this answer skip walking live sessions to find it.
  readonly hasScreenDetector: boolean;

  private readonly adapters: Readonly<Record<AgentID, AgentAdapter>>;

  private readonly store: FleetStore;

  private readonly statusPath: string;

  private readonly targets: ReadonlyMap<string, ExecutionTarget>;

  private readonly targetErrors: readonly TargetConfigError[];

  // Sessions whose revive waits on their host waking, so a second revive
  // of the same session does not start a second harness.
  private readonly adopting = new Set<SessionID>();

  // Sessions dropped from the list on purpose whose rows the next fleet
  // write deletes; each stays here until a write carrying it lands.
  private readonly removedIDs = new Set<SessionID>();

  // The epoch the next harness start or attach takes, unique across every
  // session this manager holds.
  private nextBridgeEpoch = 1;

  constructor(
    fallback: AgentAdapter,
    store: FleetStore,
    statusPath: string | undefined = statusFile,
    adapters: readonly AgentAdapter[] = [],
    targets: readonly ExecutionTarget[] = [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: LOCAL_TARGET_IDENTITY,
        provider: new LocalPTYProvider(),
      },
    ],
    targetErrors: readonly TargetConfigError[] = [],
  ) {
    // Each adapter names the id it answers to, so a registry key can never
    // disagree with the adapter behind it. A later one wins the id.
    this.adapters = Object.fromEntries([fallback, ...adapters].map((a) => [a.id, a]));
    this.hasScreenDetector = Object.values(this.adapters).some((a) => a.screenDetector !== null);
    this.store = store;
    this.statusPath = statusPath ?? statusFile;

    this.targets = new Map(targets.map((t) => [t.id, t]));

    this.targetErrors = targetErrors;
  }

  /**
   * The provider a binding's work runs on, after every target check: throws
   * the refusal for a target the config leaves unusable, one that is gone,
   * one whose identity is not the binding's, one with no provider here, and
   * a provider that lacks the capability. Returns the identity a new session
   * binds to as well.
   */
  requireExecution(
    binding: Readonly<TargetBinding>,
    capability: ExecutionCapability,
  ): { readonly provider: ExecutionProvider; readonly identity: string } {
    const refusal = this.findExecutionRefusal(binding, capability);
    const target = this.targets.get(binding.target);

    if (refusal !== null) {
      throw refusal;
    }

    if (target === undefined || target.provider === null) {
      throw new Error(`execution target '${binding.target}' passed its checks without a provider`);
    }

    return { provider: target.provider, identity: target.identity };
  }

  // The refusal for running work of a capability on a binding's target, or
  // null when the target serves it. A null target is a spawn that names
  // none when the config gives no default, which is always refused.
  findExecutionRefusal(
    binding: Readonly<{ target: string | null; targetIdentity: string | null }>,
    capability: ExecutionCapability,
  ): DaemonError | null {
    return findExecutionRefusal(this.targets, this.targetErrors, binding, capability);
  }

  // The provider a session's harness runs on, or null when its target is
  // gone from the config or has no provider here.
  findProvider(s: Session): ExecutionProvider | null {
    return this.targets.get(s.target)?.provider ?? null;
  }

  /**
   * Adapter registered under this id, or null when there is none. Lookup
   * never falls back to another id: a session whose agent is not registered
   * is unsupported, not somebody else's spawn.
   */
  findAdapter(id: AgentID): AgentAdapter | null {
    return this.adapters[id] ?? null;
  }

  // Every registered adapter, one per id, in registration order.
  collectAdapters(): AgentAdapter[] {
    return Object.values(this.adapters);
  }

  // Hands a live terminal session off to a headless run: the terminal dies,
  // the record lives on as a headless session and keeps its screen history.
  yankHeadless(id: SessionID): Session | null {
    const s = this.sessions.find((x) => x.id === id);

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
    this.emitChange();

    return s;
  }

  // A sibling's revive failing leaves that sibling asleep; the session
  // whose revive woke the host is already running, so the failure is
  // logged rather than thrown.
  private async tryAdoptSibling(
    sibling: Session,
    s: Session,
    cols: number,
    rows: number,
  ): Promise<void> {
    try {
      await this.adoptTerminal(sibling.id, cols, rows);
    } catch (error) {
      this.log(
        `atc could not revive session ${sibling.id} beside ${s.id} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // Registers a fleet entry as a session with no terminal yet, under the
  // atc session id its row holds, so a fleet-wide restore can show every
  // incoming session at once; adopting it later attaches the terminal.
  // Exited entries come back as killed sessions: still listed and revivable,
  // never auto-adopted. An entry without an agent session id has nothing to
  // resume, so it comes back exited too.
  restore(entry: FleetEntry): Session {
    const target = entry.target ?? 'local';
    const targetIdentity = entry.targetIdentity ?? LOCAL_TARGET_IDENTITY;
    const refusal = this.findExecutionRefusal({ target, targetIdentity }, 'spawn');
    const targetRefusal = refusal === null ? null : formatTargetRefusal(refusal.code, target);

    // A session whose target this daemon cannot use comes back exited, so
    // nothing runs it anywhere else: neither a terminal nor a headless turn.
    const exited =
      entry.exited === true || entry.agentSessionID === undefined || targetRefusal !== null;

    // An entry whose agent is no longer registered still gets its row, so a
    // backend dropped from the config shows as itself instead of vanishing or
    // reviving under another agent. Adopting a terminal for it is refused.
    let lastMsg = 'waiting to restore';

    if (exited && entry.desired === 'sleep') {
      lastMsg = 'asleep';
    } else if (entry.exited !== true && entry.agentSessionID === undefined) {
      lastMsg = 'nothing to resume';
    } else if (entry.exited !== true && targetRefusal !== null) {
      lastMsg = targetRefusal;
    } else if (exited) {
      lastMsg = 'killed';
    } else if (this.findAdapter(entry.agent) === null) {
      lastMsg = `no adapter for '${entry.agent}'`;
    }

    const parent = entry.parent ?? null;

    const session: Session = {
      id: entry.sessionID,
      name: entry.name,
      cwd: entry.cwd,
      kind: 'headless',
      pty: null,
      state: exited ? 'exited' : 'running',
      unread: false,
      lastMsg,
      ...(entry.agentSessionID === undefined ? {} : { agentSessionID: entry.agentSessionID }),
      agent: entry.agent,
      pinned: entry.pinned ?? false,
      lastAttachedAt: entry.lastAttachedAt ?? Date.now(),
      repoRoot: resolveRepoRoot(entry.cwd),
      namedBy: 'auto',
      createdAt: Date.now(),
      parent: parent !== null && this.sessions.some((s) => s.id === parent) ? parent : null,
      ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.transcriptPath === undefined ? {} : { transcriptPath: entry.transcriptPath }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
      target,
      targetIdentity,
      ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
      withheldEnv: entry.withheldEnv ?? [],
      desired: entry.desired ?? 'run',
      suspended: exited && entry.desired === 'sleep',
      vm: this.pickRestoredVM(target, entry.desired),
      attachment: this.hasHostLifecycle(target) ? 'detached' : 'local',
      hostKey: entry.hostKey ?? entry.sessionID,
      bridgeEpoch: 0,
    };

    this.sessions.push(session);
    this.writeStatus();
    this.onEvent('added', session);

    return session;
  }

  // Whether a target's host has a lifecycle of its own that the daemon
  // follows: one that can sleep or be destroyed. The daemon's own machine
  // has none.
  private hasHostLifecycle(target: string): boolean {
    const capabilities = this.targets.get(target)?.provider?.capabilities;

    return capabilities !== undefined && (capabilities.suspend || capabilities.destroy);
  }

  // The host state a restored session lists with: asleep when the operator
  // left it asleep, unknown for any other remote host until the daemon
  // reaches it, and none on the daemon's own machine.
  private pickRestoredVM(
    target: string,
    desired: 'sleep' | 'stop' | undefined,
  ): SessionLifecycle['vm'] {
    if (!this.hasHostLifecycle(target)) {
      return 'none';
    }

    return desired === 'sleep' ? 'asleep' : 'unknown';
  }

  // Adopts a headless session back into a terminal: a fresh PTY resumes the
  // same agent session id. On a remote host the host wakes first, and a
  // harness still running inside it is attached rather than started again;
  // every other session left asleep on that host comes back with it.
  async adoptTerminal(id: SessionID, cols: number, rows: number): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty !== null || s.agentSessionID === undefined || this.adopting.has(id)) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const provider = this.requireExecution(s, 'spawn').provider;

    this.adopting.add(id);

    let plan: SpawnPlan;

    try {
      plan = await this.setupHarness(adapter, provider, s.id, s.hostKey, s.target, {
        prompt: '',
        resume: s.agentSessionID,
        ...(s.model === undefined ? {} : { model: s.model }),
        ...(s.effort === undefined ? {} : { effort: s.effort }),
      });
    } finally {
      this.adopting.delete(id);
    }

    // A kill or a second adopt can land while the host wakes.
    if (s.pty !== null || !this.sessions.includes(s)) {
      return null;
    }

    const binding = this.mintBridgeBinding(s.id, s.target, s.targetIdentity, s.hostKey);

    const pty = provider.spawnHarness({
      session: s.id,
      host: s.hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd: s.cwd,
      env: { ATC_SESSION_ID: s.id, ATC_SOCKET: socketPath },
      withheldEnv: s.withheldEnv,
      cols,
      rows,
      onRelay: (relay) => {
        this.onRelay(binding, relay);
      },
    });

    s.bridgeEpoch = binding.epoch;
    s.pty = pty;
    s.kind = 'pty';
    s.state = 'running';
    s.lastMsg = 'revived';
    s.desired = 'run';
    s.suspended = false;

    this.attachHarness(s, pty, this.hasHostLifecycle(s.target));
    this.onBoot(s, cols, rows);
    void this.tryWriteFleet(s.id);
    this.onEvent('state', s);
    this.emitChange();

    for (const asleep of this.sessions) {
      if (asleep.hostKey === s.hostKey && asleep.target === s.target && asleep.suspended) {
        await this.tryAdoptSibling(asleep, s, cols, rows);
      }
    }

    return s;
  }

  // Follows a harness's output and its end. An exit, or a host that lost the
  // process, leaves the session exited; a host that went to sleep with the
  // process inside leaves it suspended, for a revive to find. A session
  // mid-handoff keeps its headless state, since the terminal dying is
  // expected there.
  private attachHarness(s: Session, pty: HarnessHandle, hostLifecycle: boolean): void {
    s.vm = hostLifecycle ? 'awake' : 'none';
    s.attachment = hostLifecycle ? 'attached' : 'local';

    pty.onData((d) => {
      this.onOutput(s, d);
    });

    pty.onAttachment?.((attachment) => {
      if (s.pty !== pty || s.attachment === attachment) {
        return;
      }

      s.attachment = attachment;

      this.onEvent('state', s);
      this.emitChange();
    });

    pty.onExit((exit) => {
      if (s.pty !== pty) {
        return;
      }

      s.pty = null;

      if (hostLifecycle) {
        s.attachment = 'detached';
      }

      if (s.kind === 'pty' && s.state !== 'exited') {
        s.state = 'exited';
        s.unread = this.focusedId !== s.id;
        s.lastMsg = pickExitMessage(exit);
      }

      if (exit.reason === 'suspended') {
        s.vm = 'asleep';
        s.suspended = true;
      }

      this.onEvent('state', s);
      this.emitChange();
    });
  }

  /**
   * Renames and/or pins a session on a caller's behalf. A rename lands at
   * user strength, so auto-summaries stop overwriting it while an
   * in-session rename still wins. Pinned sessions lead every list. A
   * sub-session takes its pin from its parent, so pinning one is refused.
   */
  updateSession(id: SessionID, name?: string, pinned?: boolean): boolean | 'child_pin' {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    if (pinned !== undefined && s.parent !== null) {
      return 'child_pin';
    }

    if (name !== undefined && name !== '' && s.namedBy !== 'agent') {
      s.name = name;
      s.namedBy = 'user';

      this.onEvent('renamed', s);
    }

    if (pinned !== undefined && pinned !== s.pinned) {
      s.pinned = pinned;

      this.onEvent('state', s);
    }

    void this.tryWriteFleet(s.id);
    this.writeStatus();
    this.emitChange();

    return true;
  }

  // A result, when given, becomes the session's latest result the way a
  // terminal turn's final message does.
  updateSurfaceState(id: SessionID, state: SessionState, msg: string, result?: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.kind !== 'headless') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;
    s.unread = this.focusedId !== s.id;

    if (result !== undefined) {
      s.result = truncateToBytes(result, 16_384);
      s.lastDetail = truncateDetail(result);
      void this.tryUpdateFleetEntry(s.id, { result: s.result });
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  // The detector-stack screen tier reports through here: only flips between
  // running and needs_you — hook-driven done/exited states always win.
  updateAttention(id: SessionID, state: 'needs_you' | 'running', msg: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.state === state) {
      return;
    }

    if (s.state !== 'running' && s.state !== 'needs_you') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;

    if (state === 'needs_you') {
      s.unread = this.focusedId !== s.id;
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  get focused(): Session | null {
    return this.sessions.find((s) => s.id === this.focusedId) ?? null;
  }

  // resume: true opens the agent's own session picker; an agent session id
  // resumes that specific session (fleet restore). parent makes the new
  // session a sub-session of that one. overrides hold the model and effort
  // the new process runs with, and the session keeps them for every revive.
  // id is minted here unless the caller minted it ahead of the spawn. target
  // is the execution target the harness runs on; one this daemon cannot use
  // refuses the spawn before anything starts. materialized holds what cwd
  // was materialized from, when it was, and the variables the session's
  // harnesses go without.
  async spawn(
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
    materialized: MaterializedSpawn | null = null,
  ): Promise<Session> {
    const adapter = this.findAdapter(agent);

    if (adapter === null) {
      throw new Error(`no adapter for agent '${agent}'`);
    }

    const execution = this.requireExecution({ target, targetIdentity: null }, 'spawn');
    const provider = execution.provider;

    // The repository root resolves before the process starts: resolving it
    // can throw, and a spawn that throws must leave nothing running. A
    // remote directory is not on the daemon's machine, so it is its own root.
    const repoRoot = provider.remote ? cwd : resolveRepoRoot(cwd);
    const hostKey = this.pickHostKey(id, parent, target, execution.identity);

    const plan = await this.setupHarness(adapter, provider, id, hostKey, target, {
      prompt,
      resume,
      ...overrides,
    });

    const binding = this.mintBridgeBinding(id, target, execution.identity, hostKey);

    const pty = provider.spawnHarness({
      session: id,
      host: hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd,
      env: { ATC_SESSION_ID: id, ATC_SOCKET: socketPath },
      withheldEnv: materialized?.withheldEnv ?? [],
      cols,
      rows,
      onRelay: (relay) => {
        this.onRelay(binding, relay);
      },
    });

    let initialMsg = prompt;

    if (initialMsg === '') {
      initialMsg = resume === false ? 'started' : 'adopting…';
    }

    const session: Session = {
      id,
      name,
      cwd,
      kind: 'pty',
      pty,
      state: 'running',
      unread: false,
      lastMsg: initialMsg,
      ...(typeof resume === 'string' ? { agentSessionID: resume } : {}),
      agent,
      pinned: false,
      lastAttachedAt: Date.now(),
      repoRoot,
      namedBy,
      createdAt: Date.now(),
      parent,
      ...(prompt === '' ? {} : { prompt }),
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
      target,
      targetIdentity: execution.identity,
      ...(materialized === null ? {} : { workspace: materialized.workspace }),
      withheldEnv: materialized?.withheldEnv ?? [],
      desired: 'run',
      vm: 'none',
      attachment: 'local',
      suspended: false,
      hostKey,
      bridgeEpoch: binding.epoch,
    };

    this.attachHarness(session, pty, this.hasHostLifecycle(target));
    this.sessions.push(session);
    void this.tryWriteFleet(session.id);
    this.writeStatus();
    this.onEvent('added', session);
    this.onBoot(session, cols, rows);

    return session;
  }

  // The binding a harness start or attach opens its bridge under, at a
  // fresh epoch.
  private mintBridgeBinding(
    sessionID: SessionID,
    target: string,
    targetIdentity: string,
    hostKey: SessionID,
  ): BridgeBinding {
    const epoch = this.nextBridgeEpoch;

    this.nextBridgeEpoch += 1;

    return { sessionID, target, targetIdentity, hostKey, epoch };
  }

  // Readies the host a harness is about to start on and plans the harness.
  // On a remote host the agent plans a guest spawn, whose files unpack into
  // the session's own guest folder, and the agent's sign-in check runs
  // there first. Every refusal comes before the harness starts.
  private async setupHarness(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    options: SpawnOptions,
  ): Promise<SpawnPlan> {
    if (!provider.remote) {
      await provider.prepareHost({ host: hostKey, daemonID: this.store.daemonID });

      return adapter.planSpawn(options);
    }

    const guest = provider.guest ?? { dir: '/tmp/atc', atc: null };
    const dir = `${guest.dir}/sessions/${id}`;

    const plan =
      adapter.planGuestSpawn === undefined
        ? { ...adapter.planSpawn(options), files: {} }
        : adapter.planGuestSpawn(options, { atc: guest.atc, dir });

    if (plan === null) {
      throw buildGuestRefusal(provider.kind, adapter.id, target, guest.atc === null);
    }

    await provider.prepareHost({
      host: hostKey,
      daemonID: this.store.daemonID,
      installATC: adapter.planGuestSpawn !== undefined,
    });

    const check = adapter.planAuthCheck?.();

    if (check !== undefined) {
      const result = await provider.runCommand({ argv: check, cwd: '/', host: hostKey });

      if (result.exitCode !== 0) {
        throw new DaemonError(
          'auth_not_configured',
          `agent '${adapter.id}' is not signed in on target '${target}'; sign it in inside the host's image`,
          { agent: adapter.id, target },
        );
      }
    }

    const files = Object.entries(plan.files).map(([path, content]) => ({ path, content }));

    if (files.length > 0) {
      await provider.transferArchive(buildTarArchive(files), dir, hostKey);
    }

    return plan;
  }

  // A sub-session runs on its parent's host when its resolved target, name
  // and identity both, is the one its parent is bound to and that target's
  // hosts have a lifecycle, so one host serves a top-level session and
  // every sub-session beside it there; any other session has a host of its
  // own.
  private pickHostKey(
    id: SessionID,
    parent: SessionID | null,
    target: string,
    identity: string,
  ): SessionID {
    const owner = parent === null ? undefined : this.sessions.find((s) => s.id === parent);

    if (
      owner === undefined ||
      owner.target !== target ||
      owner.targetIdentity !== identity ||
      !this.hasHostLifecycle(target)
    ) {
      return id;
    }

    return owner.hostKey;
  }

  // Takes back a spawn that failed after its process started: the process
  // dies and the session leaves the list and the fleet, so the spawn leaves
  // nothing behind. It resolves only once the process has exited and the
  // fleet without the session is durable, and throws when the kill, the
  // exit, or that write cannot be confirmed. A session whose exit is not
  // confirmed stays listed, so the spawn's caller can still find it. A
  // session that never registered is left alone.
  async removeFailedSpawn(id: SessionID): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return;
    }

    const pty = s.pty;

    if (pty !== null) {
      pty.kill();

      if (!(await pty.waitForExit(FAILED_SPAWN_EXIT_WAIT_MS))) {
        throw new Error(
          `session ${id} did not exit within ${FAILED_SPAWN_EXIT_WAIT_MS}ms of its kill`,
        );
      }
    }

    s.pty = null;

    this.remove(s);
    this.emitChange();

    await this.writeFleet();
  }

  collectDescriptors(): SessionDescriptor[] {
    return this.sessions.map((s) => ({
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
      canEject: (this.findAdapter(s.agent)?.headlessRunner ?? null) !== null,
      ...(s.parent === null ? {} : { parent: s.parent }),
      locator: { daemonID: this.store.daemonID, targetID: s.target },
      ...(s.workspace === undefined ? {} : { workspace: s.workspace }),
      lifecycle: buildLifecycle(s),
    }));
  }

  // The live and dead sub-sessions of a session, in list order.
  collectChildren(id: SessionID): Session[] {
    return this.sessions.filter((s) => s.parent === id);
  }

  // Returns the normalized event so the caller can key lifecycle bookkeeping
  // and the event trail on it, or null when no session or adapter matches.
  applyHook(e: HookEvent): AdapterEvent | null {
    const s = this.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const ev = adapter.normalizeHook(e);

    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (s.kind === 'headless') {
      return ev;
    }

    const focused = this.focusedId === s.id;
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

    switch (ev.kind) {
      case 'started': {
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';
          dirty = true;
        }

        break;
      }
      case 'needs-input': {
        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = ev.message ?? 'needs input';
        dirty = true;
        break;
      }
      case 'turn-done': {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';
        dirty = true;

        if (ev.result !== undefined) {
          // A runaway final message cannot bloat the fleet row.
          s.result = truncateToBytes(ev.result, 16_384);
          rowUpdate.result = s.result;
        }

        break;
      }
      case 'prompt-submitted': {
        s.state = 'running';
        s.unread = false;
        s.lastMsg = ev.message ?? 'working';
        dirty = true;
        break;
      }

      // A live terminal can report an end without dying — resuming claude
      // closes the superseded session while its process stays interactive.
      // Exited is reserved for a gone terminal; onExit owns that transition.
      case 'ended': {
        if (s.pty === null) {
          s.state = 'exited';
        }

        s.unread = false;
        s.lastMsg = 'session ended';
        dirty = true;
        break;
      }

      // Heartbeats only matter for the agent-session-id capture above.
      case 'heartbeat': {
        break;
      }
    }

    // A fleet rewrite marks every session without a PTY as exited, so only a
    // new agent session id takes it. Anything else touches this session's
    // own row.
    if (persist) {
      void this.tryWriteFleet(s.id);
    } else {
      void this.tryUpdateFleetEntry(s.id, rowUpdate);
    }

    if (dirty) {
      this.onEvent('state', s);
      this.emitChange();
    }

    return ev;
  }

  private async refreshName(s: Session, source: string) {
    const adapter = this.findAdapter(s.agent);

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

    void this.tryWriteFleet(s.id);
    this.onEvent('renamed', s);
    this.emitChange();
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(id: SessionID): string | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return null;
    }

    return this.findAdapter(s.agent)?.buildResumeCommand(s.cwd, s.agentSessionID) ?? null;
  }

  attach(id: SessionID) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    s.unread = false;
    s.lastAttachedAt = Date.now();
    void this.tryWriteFleet(s.id);

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (s.state === 'needs_you') {
      s.state = 'running';
      s.lastMsg = 'attached';
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  ack(id: SessionID) {
    const s = this.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;

      this.onEvent('state', s);
    }

    this.emitChange();
  }

  // A kill's response is the caller's cue that the session is safely
  // archived, so the write it depends on must land before that response
  // goes out. A kill acts on the whole set: killing a session kills its
  // live sub-sessions with it, and forgetting a dead one forgets its dead
  // sub-sessions and promotes any live ones to top level. A live session
  // that owns a host that can sleep puts the host to sleep instead, with
  // every harness on it kept inside, and fails whole when the host stays
  // awake. A dead session on a target that can destroy its host is not
  // forgotten by a kill: forgetting it destroys the host, which takes a
  // confirmed forget.
  async kill(id: SessionID): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    if (s.pty) {
      await this.stopHarness(s);

      for (const child of this.collectChildren(id)) {
        await this.tryStopHarness(child);
      }
    } else {
      if (this.findProvider(s)?.capabilities.destroy === true) {
        throw new DaemonError(
          'confirmation_required',
          `forgetting session ${id} destroys its host on target '${s.target}'; confirm it with session.forget`,
          { session: id },
        );
      }

      this.updateForgottenChildren(id);
      this.remove(s);
    }

    await this.writeFleet();

    this.emitChange();
  }

  /**
   * Forgets a session for good, whether it runs or not, and returns whether
   * its host was destroyed. A session that owns a host its target can
   * destroy destroys the host, and every session on that host goes with it;
   * a session on its parent's host ends its own harness alone, and one
   * kept asleep in that host is refused until the host wakes. Its dead
   * sub-sessions on other hosts go with it, unless their own target can
   * destroy their host, and its live ones become top-level. A failed destroy
   * throws before anything is forgotten.
   */
  async forget(id: SessionID): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    const provider = this.findProvider(s);
    const destroys = provider !== null && provider.capabilities.destroy && s.hostKey === s.id;

    // A harness kept inside a sleeping host it does not own still has a
    // process there, which the daemon can neither reach nor end while the
    // host sleeps. Its record keeps that process owned until the host wakes
    // or its owner's forget destroys the host.
    if (!destroys && s.pty === null && s.vm === 'asleep') {
      throw new DaemonError(
        'unsupported_operation',
        `session ${id} sleeps inside the host of session ${s.hostKey}; revive it or forget session ${s.hostKey} first`,
        { provider: provider?.kind ?? null, problem: 'host_asleep', host: s.hostKey },
      );
    }

    if (destroys) {
      await provider.destroyHost(s.hostKey);

      for (const onHost of this.sessions) {
        if (onHost.hostKey === s.hostKey && onHost.target === s.target && onHost.id !== s.id) {
          onHost.pty?.detach();
          onHost.pty = null;

          this.remove(onHost);
        }
      }

      s.pty?.detach();
      s.pty = null;
    } else {
      this.killTerminal(s);
    }

    this.updateForgottenChildren(id);
    this.remove(s);

    await this.writeFleet();

    this.emitChange();

    return destroys;
  }

  // A forgotten parent's dead sub-sessions go with it, except one whose own
  // target can destroy its host: forgetting that one destroys the host, which
  // takes its own confirmed forget. Every sub-session that stays becomes
  // top-level.
  private updateForgottenChildren(id: SessionID): void {
    for (const child of this.collectChildren(id)) {
      const live = child.pty !== null || (child.kind === 'headless' && child.state !== 'exited');

      if (live || this.findProvider(child)?.capabilities.destroy === true) {
        child.parent = null;

        this.onEvent('state', child);
      } else {
        this.remove(child);
      }
    }
  }

  /**
   * The capability a kill of a live session needs on its target: `suspend`
   * for a session that owns a host that can sleep, `kill` for any other.
   */
  pickKillCapability(s: Session): ExecutionCapability {
    return this.canSuspendHost(s) ? 'suspend' : 'kill';
  }

  private canSuspendHost(s: Session): boolean {
    return s.hostKey === s.id && this.findProvider(s)?.capabilities.suspend === true;
  }

  // Puts the session's host to sleep when it owns one that can sleep, and
  // ends its harness otherwise. A refused sleep throws before anything
  // changes.
  private async stopHarness(s: Session): Promise<void> {
    const provider = this.findProvider(s);

    if (provider === null || !this.canSuspendHost(s)) {
      this.killTerminal(s);

      return;
    }

    await provider.suspendHost(s.hostKey);

    for (const onHost of this.sessions) {
      if (onHost.hostKey === s.hostKey && onHost.target === s.target) {
        this.updateSuspended(onHost);
      }
    }
  }

  // A sub-session whose host stays awake is ended instead, so a kill
  // never leaves part of its set running.
  private async tryStopHarness(s: Session): Promise<void> {
    if (s.pty === null) {
      this.killTerminal(s);

      return;
    }

    try {
      await this.stopHarness(s);
    } catch (error) {
      this.log(
        `atc could not put the host of session ${s.id} to sleep (${error instanceof Error ? error.message : String(error)}); ending its harness instead`,
      );

      this.killTerminal(s);
    }
  }

  // A harness inside a host that went to sleep: the daemon lets go of it,
  // and the process stays inside the host for a revive to find.
  private updateSuspended(s: Session): void {
    s.vm = 'asleep';

    if (s.pty === null) {
      this.onEvent('state', s);

      return;
    }

    s.pty.detach();

    s.pty = null;
    s.state = 'exited';
    s.lastMsg = 'asleep';
    s.desired = 'sleep';
    s.attachment = 'detached';
    s.suspended = true;

    this.onEvent('state', s);
  }

  // Ends a live session, terminal or headless, leaving a dead entry; a
  // session already dead is left as it is.
  private killTerminal(s: Session) {
    if (s.pty !== null) {
      s.pty.kill();

      s.pty = null;
    } else if (s.kind !== 'headless' || s.state === 'exited') {
      return;
    }

    s.state = 'exited';
    s.lastMsg = 'killed';
    s.desired = 'stop';

    this.onEvent('state', s);
  }

  private remove(s: Session) {
    this.sessions = this.sessions.filter((x) => x.id !== s.id);

    this.removedIDs.add(s.id);

    if (this.focusedId === s.id) {
      this.focusedId = null;
    }

    this.onEvent('removed', s);
  }

  // Lets go of every harness as the daemon stops: one on the daemon's own
  // machine ends with it, and one on a remote host runs on for the next
  // daemon to attach.
  detachAll() {
    for (const s of this.sessions) {
      s.pty?.detach();
    }
  }

  private emitChange() {
    this.writeStatus();
    this.onChange();
  }

  // Consumed by the injected statusline command so wrangled sessions render
  // fleet state inside their own status line.
  writeStatus() {
    const c = this.countStates();
    const urgent = this.sortSessions().find((s) => s.state === 'needs_you');

    try {
      writeFileSync(this.statusPath, JSON.stringify({ ...c, urgent: urgent?.name ?? null }));
    } catch {}
  }

  // Persisted continuously so a crash (or quit) leaves a restorable fleet.
  // A write covers the listed sessions and the ones dropped on purpose
  // since the last write; a stored row the daemon has not restored yet
  // stays as it is, so a write before `R` keeps it restorable. Deliberate
  // kills rewrite the fleet; unexpected session/atc deaths do not, so the
  // last known fleet survives for `R` restore. Sessions whose
  // terminal is gone persist as exited entries, so the killed archive
  // survives a daemon restart too. A session the agent has not yet given
  // its own session id persists as well, under its atc session id alone.
  async writeFleet(): Promise<void> {
    const fleet: FleetEntry[] = [];

    for (const s of this.sessions) {
      const live = s.pty !== null || (s.kind === 'headless' && s.state !== 'exited');

      fleet.push({
        sessionID: s.id,
        name: s.name,
        cwd: s.cwd,
        ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
        agent: s.agent,
        ...(s.pinned ? { pinned: true } : {}),
        lastAttachedAt: s.lastAttachedAt,
        ...(live ? {} : { exited: true }),
        ...(s.parent === null ? {} : { parent: s.parent }),
        ...(s.prompt === undefined ? {} : { prompt: s.prompt }),
        ...(s.result === undefined ? {} : { result: s.result }),
        ...(s.transcriptPath === undefined ? {} : { transcriptPath: s.transcriptPath }),
        ...(s.model === undefined ? {} : { model: s.model }),
        ...(s.effort === undefined ? {} : { effort: s.effort }),
        target: s.target,
        targetIdentity: s.targetIdentity,
        ...(s.desired === 'run' ? {} : { desired: s.desired }),
        ...(s.hostKey === s.id ? {} : { hostKey: s.hostKey }),
      });
    }

    const removed = [...this.removedIDs];

    await this.store.writeFleet(fleet, removed);

    for (const id of removed) {
      this.removedIDs.delete(id);
    }
  }

  // A write nobody awaits that fails leaves the stored rows as they were,
  // and must not take the daemon down unhandled. A stale ownership epoch is
  // expected and surfaces on the next write a request awaits; any other
  // failure is logged with the session whose change it was writing.
  private async tryWriteFleet(sessionID: SessionID): Promise<boolean> {
    try {
      await this.writeFleet();
    } catch (error) {
      this.logStoreFailure(sessionID, error);

      return false;
    }

    return true;
  }

  private async tryUpdateFleetEntry(id: SessionID, fields: FleetEntryUpdate): Promise<boolean> {
    try {
      await this.store.updateFleetEntry(id, fields);
    } catch (error) {
      this.logStoreFailure(id, error);

      return false;
    }

    return true;
  }

  private logStoreFailure(sessionID: SessionID, error: unknown): void {
    if (error instanceof DaemonError && error.code === 'stale_epoch') {
      return;
    }

    const code = error instanceof DaemonError ? error.code : 'internal';
    const message = error instanceof Error ? error.message : String(error);

    this.log(`atc fleet write for session ${sessionID} failed (${code}): ${message}`);
  }

  countStates() {
    return countSessionStates(this.sessions);
  }

  sortSessions(): Session[] {
    return sortSessionViews(this.sessions);
  }
}

export function countSessionStates(
  list: readonly { readonly state: SessionState }[],
): Record<SessionState, number> {
  const c = { needs_you: 0, running: 0, done: 0, exited: 0 };

  for (const s of list) {
    c[s.state]++;
  }

  return c;
}

interface SortableSessionView {
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
}

// Overlay order: pinned sessions first in most-recently-attached order, then
// everyone else by urgency — who needs you, finished turns, busy, dead —
// with most-recently-attached breaking ties inside each state. A
// sub-session sits directly under its parent, ranked among its siblings
// alone, so its attention never moves the parent's row; a sub-session whose
// parent is not listed ranks as a top-level row.
export function sortSessionViews<T extends SortableSessionView>(list: readonly T[]): T[] {
  const rank: Record<SessionState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
  };

  const ranked = [...list].toSorted((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }

    const recency = b.lastAttachedAt - a.lastAttachedAt || b.createdAt - a.createdAt;

    return a.pinned ? recency : rank[a.state] - rank[b.state] || recency;
  });

  const listed = new Set(ranked.map((s) => s.id));

  const sorted: T[] = [];

  for (const s of ranked) {
    if (s.parent !== null && listed.has(s.parent)) {
      continue;
    }

    sorted.push(s, ...ranked.filter((child) => child.parent === s.id));
  }

  return sorted;
}

// Never a filesystem path, so a repository can't collide with it.
export const PINNED_GROUP_KEY = ' pinned';

// Overlay display order for the grouped view: the flat sort with each
// repository's sessions pulled together at the position of its best-ranked
// member, so the renderer's adjacency-based headers appear once per group.
// Pinned sessions form their own leading group. A sub-session keys by its
// parent, so a set never splits across groups.
export function sortGroupedSessionViews<
  T extends SortableSessionView & { readonly repoRoot: string },
>(list: readonly T[]): T[] {
  const byID = new Map(list.map((s) => [s.id, s]));
  const buckets = new Map<string, T[]>();

  for (const s of sortSessionViews(list)) {
    const owner = (s.parent === null ? undefined : byID.get(s.parent)) ?? s;
    const key = owner.pinned ? PINNED_GROUP_KEY : owner.repoRoot;
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [s]);
    } else {
      bucket.push(s);
    }
  }

  return [...buckets.values()].flat();
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

// An agent that plans no remote spawn: for want of an atc inside the host
// when the host has none, or because the agent never runs remotely.
function buildGuestRefusal(
  provider: string,
  agent: string,
  target: string,
  hasNoATC: boolean,
): DaemonError {
  return hasNoATC
    ? new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on target '${target}': its host has no atc to report through; run a compiled atc daemon on Linux, or set the target's guestATC to an atc installed in its image`,
        { provider, agent, problem: 'no_guest_atc' },
      )
    : new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on a remote target such as '${target}'`,
        { provider, agent, problem: 'remote_unsupported' },
      );
}

// Why a harness stopped, as a session's last message.
function pickExitMessage(exit: Readonly<{ reason?: string; detail?: string }>): string {
  if (exit.reason === 'suspended') {
    return 'asleep';
  }

  if (exit.reason === 'ended') {
    return exit.detail ?? 'host lost the process';
  }

  return 'process exited';
}

// A target refusal as a session's last message, short enough for a list row.
function formatTargetRefusal(code: ErrorCode, target: string): string {
  if (code === 'target_config_invalid') {
    return `target '${target}' misconfigured`;
  }

  if (code === 'unknown_target') {
    return `no target '${target}'`;
  }

  if (code === 'target_changed') {
    return `target '${target}' changed`;
  }

  if (code === 'target_unavailable') {
    return `target '${target}' unavailable`;
  }

  return `target '${target}' cannot start a terminal`;
}
