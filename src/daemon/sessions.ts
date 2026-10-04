import { writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import type {
  AgentAdapter,
  GuestPaths,
  SpawnOptions,
  SpawnOverrides,
  SpawnPlan,
} from '../agents/agent-adapter';
import type { AdapterEvent } from '../protocol/adapter-event';
import { countSessionStates } from '../protocol/count-session-states';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { ErrorCode } from '../protocol/protocol';
import type { SessionState } from '../protocol/session-state';
import { sortSessionViews } from '../protocol/sort-session-views';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { TargetConfigError } from '../shared/collect-targets';
import { socketPath, statusFile } from '../shared/config';
import type { DaemonID } from '../shared/daemon-id';
import { isBrokerVariable } from '../shared/is-broker-variable';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import type { SessionID } from '../shared/session-id';
import { truncateDetail } from '../shared/truncate-detail';
import { truncateToBytes } from '../shared/truncate-to-bytes';
import type { FleetEntry, FleetEntryUpdate, FleetStore } from '../store/fleet-entry';
import type { SessionWorkspace } from '../store/workspace-materialization';
import type { BrokerAuthHost } from './broker-auth-host';
import { buildAuthBinding } from './build-auth-binding';
import type { AuthBinding } from './build-auth-binding';
import type { ExecutionTarget } from './build-execution-targets';
import { buildSessionLifecycle } from './build-session-lifecycle';
import type { SessionLifecycle } from './build-session-lifecycle';
import { buildTarArchive } from './build-tar-archive';
import { buildTargetIdentity } from './build-target-identity';
import { EffectRemainsError } from './effect-remains-error';
import type {
  ExecutionCapability,
  ExecutionProvider,
  HarnessHandle,
  HarnessRelay,
  HarnessSpec,
} from './execution-provider';
import { findExecutionRefusal } from './find-execution-refusal';
import type { BridgeBinding } from './is-binding-current';
import { LocalPTYProvider } from './local-pty-provider';
import { mintSessionID } from './mint-session-id';
import { pickSessionState } from './pick-session-state';
import type { RuntimeAuthBinder } from './runtime-auth-binder';

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

// Builds a spawn's workspace on a target bound to an identity, calling
// readyHost for the host it lands on once its source resolves and asking
// canRemoveClaim before a failure removes the directory it claimed, or
// resolves to null for a directory that runs as it stands.
type SpawnMaterializer = (
  host: SpawnHostAccess,
  targetIdentity: string,
) => Promise<MaterializedSpawn | null>;

interface SpawnHostAccess {
  readonly readyHost: () => Promise<{ readonly host: SessionID; readonly dir: string }>;
  readonly removeClaim: (dir: string) => Promise<boolean>;
}

// A workspace directory a spawn on a shared host holds, as the spawn gave
// it and as the host resolves it once checked there.
interface WorkspaceReservation {
  readonly hostKey: SessionID;
  readonly target: string;
  readonly dir: string;
  resolved: string | null;

  // A workspace spawn builds its directory and may remove it on a failure;
  // a plain spawn only starts in its directory, which another plain spawn
  // may share.
  readonly kind: 'workspace' | 'plain';
}

// Prints a directory with every symlink in it resolved: its nearest
// existing directory as the host resolves it and a newline, which keeps a
// name that ends in newlines whole, then a NUL and the rest of the path as
// given.
const RESOLVE_DIR_SCRIPT = `p=$1; s=; while [ ! -d "$p" ]; do s=/\${p##*/}$s; p=\${p%/*}; [ -n "$p" ] || p=/; done; cd -P -- "$p" && pwd -P && printf '\\0%s' "$s"`;

// Removes a directory only while it still resolves to itself: it enters
// the directory, compares where it landed with the path it was given, and
// removes the contents from inside it, so no symlink changed on the way is
// followed, then the directory itself, which is empty by then.
const REMOVE_DIR_SCRIPT =
  'cd -P -- "$1" || exit 3; [ "$(pwd -P; printf x)" = "$2" ] || exit 4; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || exit 5; cd / && rmdir -- "$1"';

// A readied host's harness plan, and the auth attempt that provisioned the
// host, if one did.
interface HarnessSetup {
  readonly plan: HarnessPlan;
  readonly attemptID: string | null;
}

// The identity of the implicit `local` target, which a fleet row without a
// stored identity ran on.
const LOCAL_TARGET_IDENTITY = buildTargetIdentity('local-pty', {});

// How long a failed spawn's rollback waits for the killed process to exit,
// once after its kill and once more after a forced kill.
const FAILED_SPAWN_EXIT_WAIT_MS = 2000;

// How a harness takes its credential from impd's broker: the broker the
// provider reaches, and the binding the agent's selection resolves to now.
interface HarnessAuth {
  readonly host: BrokerAuthHost;
  readonly binding: AuthBinding;
}

// A harness's auth as its setup applies it: a spawn's own new host creates
// the binding, and every other launch verifies the one its host holds.
interface HarnessAuthSetup extends HarnessAuth {
  readonly mode: 'create' | 'verify';
  readonly targetIdentity: string;
}

// A harness as its setup plans it: the agent's spawn, and the variables
// the agent's guest plan starts the harness with, which no variable atc
// adds overrides.
interface HarnessPlan extends SpawnPlan {
  readonly env: Readonly<Record<string, string>>;

  // What a launch behind the broker was planned under, which its host's
  // binding must still admit when each request goes out; null without
  // runtime auth.
  readonly admission: {
    readonly revision: number;
    readonly hash: string;
    readonly attemptID: string | null;
  } | null;
}

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

  // Binds the runtime auth of each host whose agent takes its credential
  // from impd's broker; with none, every such start is refused.
  authBinder: RuntimeAuthBinder | null = null;

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

  // The launches readying each host, by host key. A launch counts from its
  // setup until its harness spawns, which follows the setup with no wait,
  // so a host with a launch in flight is never idle.
  private readonly readying = new Map<SessionID, number>();

  // The workspace directory each spawn on a shared host holds from its
  // overlap check until its session lists or its spawn fails, by spawn id.
  private readonly reservations = new Map<SessionID, WorkspaceReservation>();

  // Sessions dropped from the list on purpose whose rows the next fleet
  // write deletes; each stays here until a write carrying it lands.
  private readonly removedIDs = new Set<SessionID>();

  // Failed spawns whose rollback is running, and those whose killed process
  // it could not confirm gone, each with the harness it ran in, so no revive
  // starts a second harness while the first may still run.
  private readonly rollingBack = new Set<SessionID>();

  private readonly unconfirmedKills = new Map<SessionID, HarnessHandle>();

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

  /**
   * Throws the refusal for an agent that takes its credential from impd's
   * broker on a target whose provider reaches no broker, before a spawn
   * or an adopt does any work.
   */
  requireAgentTarget(agent: AgentID, target: string): void {
    const adapter = this.findAdapter(agent);

    if (adapter === null || (adapter.findAuthSelection?.() ?? null) === null) {
      return;
    }

    const provider = this.targets.get(target)?.provider ?? null;

    if (provider?.brokerAuth === undefined || this.authBinder === null) {
      throw buildBrokerTargetRefusal(agent, target);
    }
  }

  // Adopts a headless session back into a terminal: a fresh PTY resumes the
  // same agent session id. On a remote host the host wakes first, and a
  // harness still running inside it is attached rather than started again;
  // every other session left asleep on that host comes back with it. The
  // caller's check runs again after each await, and a failed check leaves
  // the session as it was.
  async adoptTerminal(
    id: SessionID,
    cols: number,
    rows: number,
    canProceed: () => boolean = () => true,
  ): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty !== null || s.agentSessionID === undefined || this.adopting.has(id)) {
      return null;
    }

    const settled = await this.isRollbackSettled(id);

    if (!settled || !canProceed()) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const provider = this.requireExecution(s, 'spawn').provider;
    const auth = this.resolveHarnessAuth(adapter, provider, s.target);

    const authSetup: HarnessAuthSetup | null =
      auth === null ? null : { ...auth, mode: 'verify', targetIdentity: s.targetIdentity };

    this.adopting.add(id);

    let plan: HarnessPlan;

    try {
      const setup = await this.setupHarness(
        adapter,
        provider,
        s.id,
        s.hostKey,
        s.target,
        {
          prompt: '',
          resume: s.agentSessionID,
          ...(s.model === undefined ? {} : { model: s.model }),
          ...(s.effort === undefined ? {} : { effort: s.effort }),
        },
        authSetup,
      );

      plan = setup.plan;
    } finally {
      this.adopting.delete(id);
    }

    // A kill, a second adopt, a failed spawn's rollback, or a change that
    // takes the session out of the caller's reach can land while the host
    // wakes.
    if (
      !canProceed() ||
      s.pty !== null ||
      !this.sessions.includes(s) ||
      this.rollingBack.has(id) ||
      this.unconfirmedKills.has(id)
    ) {
      return null;
    }

    const binding = this.mintBridgeBinding(s.id, s.target, s.targetIdentity, s.hostKey);

    const pty = provider.spawnHarness({
      session: s.id,
      host: s.hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd: s.cwd,
      env: { ...plan.env, ATC_SESSION_ID: s.id, ATC_SOCKET: socketPath },
      withheldEnv: s.withheldEnv,
      cols,
      rows,
      ...this.buildBrokerSpec(s.hostKey, plan.admission),
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

    if (auth !== null) {
      await this.waitForAuthStart(s, provider, pty);
    }

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
  // refuses the spawn before anything starts. materialize builds cwd on the
  // host once every refusal has passed and the host is ready, and returns
  // what cwd was materialized from, when it was, and the variables the
  // session's harnesses go without; a failure there takes back the host the
  // spawn readied, unless it is a parent's.
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
    materialize: SpawnMaterializer | null = null,
    requireInReach: () => void = () => {},
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
    const auth = this.resolveHarnessAuth(adapter, provider, target);

    if (hostKey !== id) {
      await this.requireSharedBinding(hostKey, auth?.binding ?? null);
    }

    const authSetup: HarnessAuthSetup | null =
      auth === null
        ? null
        : {
            ...auth,
            mode: hostKey === id ? 'create' : 'verify',
            targetIdentity: execution.identity,
          };

    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    if (hostKey !== id) {
      if (materialize === null) {
        this.claimPlainDir(id, hostKey, target, cwd);
      } else {
        this.claimWorkspace(id, hostKey, target, cwd);
      }
    }

    const setupHost = () =>
      this.setupHarnessOnHost(
        adapter,
        provider,
        id,
        hostKey,
        target,
        { prompt, resume, ...overrides },
        authSetup,
      );

    // The host stays readying until its workspace is in place, so nothing
    // gives its lease back or puts it to sleep in between.
    const prepared = await this.withHostReadying(hostKey, async () => {
      if (materialize === null) {
        return { setup: await setupHost(), materialized: null };
      }

      return this.materializeOnSpawnHost(
        provider,
        id,
        hostKey,
        target,
        cwd,
        execution.identity,
        materialize,
        setupHost,
      );
    });

    const setup = prepared.setup;
    const materialized = prepared.materialized;
    const plan = setup.plan;

    // The caller's check runs again once the host is ready, before the
    // harness starts.
    try {
      requireInReach();
    } catch (error) {
      await this.tryRemoveAuthAttempt(provider, hostKey, setup.attemptID);

      throw error;
    }

    const binding = this.mintBridgeBinding(id, target, execution.identity, hostKey);

    const pty = provider.spawnHarness({
      session: id,
      host: hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd,
      env: { ...plan.env, ATC_SESSION_ID: id, ATC_SOCKET: socketPath },
      withheldEnv: materialized?.withheldEnv ?? [],
      cols,
      rows,
      ...this.buildBrokerSpec(hostKey, plan.admission),
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
    this.releaseWorkspace(id);
    void this.tryWriteFleet(session.id);
    this.writeStatus();
    this.onEvent('added', session);
    this.onBoot(session, cols, rows);

    // A start impd refuses throws here, after the session listed, so the
    // caller takes the failed spawn back with its binding. A shared host
    // that nothing else runs on goes back to sleep first; a host of its
    // own goes with the take-back.
    if (auth !== null && hostKey === id) {
      await pty.waitForStart?.();
    } else if (auth !== null) {
      await this.waitForAuthStart(session, provider, pty);
    }

    if (setup.attemptID !== null) {
      await this.requireAuthBinder().updateReady(hostKey, setup.attemptID);
    }

    return session;
  }

  // What a harness of this agent needs to take its credential from impd's
  // broker on a provider, or null when the agent takes none. Throws the
  // refusal for a target whose provider has no broker, so no credential
  // ever falls back to a local start, and for a selection the current auth
  // profiles cannot bind.
  private resolveHarnessAuth(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ): HarnessAuth | null {
    const selection = adapter.findAuthSelection?.() ?? null;

    if (selection === null) {
      return null;
    }

    const host = provider.brokerAuth;

    if (host === undefined || this.authBinder === null) {
      throw buildBrokerTargetRefusal(adapter.id, target);
    }

    const planned = buildAuthBinding(selection.gateway, selection.profiles);

    if ('problem' in planned) {
      throw new DaemonError('auth_binding_invalid', planned.problem.message, {
        agent: adapter.id,
        problem: planned.problem.code,
      });
    }

    return { host, binding: planned.binding };
  }

  // A sub-session joins its parent's host only under the binding that host
  // holds: both without runtime auth, or both bound to the same hash, and
  // then only while that binding is ready.
  private async requireSharedBinding(
    hostKey: SessionID,
    binding: AuthBinding | null,
  ): Promise<void> {
    const found = await this.authBinder?.findBinding(hostKey);

    const held = found ?? null;

    if (held === null && binding === null) {
      return;
    }

    if (held !== null && binding !== null && held.bindingHash === binding.hash) {
      if (held.state !== 'ready') {
        throw new DaemonError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${held.state}; rebind it to launch again`,
          { host: hostKey, state: held.state },
        );
      }

      return;
    }

    throw new DaemonError(
      'auth_binding_mismatch',
      `a sub-session joins the host of session ${hostKey} only under the runtime auth binding that host holds`,
      { host: hostKey, hostBound: held !== null, bound: binding !== null },
    );
  }

  /**
   * Gives back the workspace directory a spawn reserved on a shared host.
   * The spawn's session listing gives it back, and so does a failed spawn,
   * except one whose effects may still stand, whose directory stays
   * reserved so no other workspace lands in or around what it left.
   */
  releaseWorkspace(id: SessionID): void {
    this.reservations.delete(id);
  }

  // Claims a workspace's directory on a shared host, refusing one inside
  // or around the directory of a session listed there or of another spawn's
  // reservation. The check and the reservation run in one turn, so of two
  // concurrent spawns at most one passes.
  private claimWorkspace(id: SessionID, hostKey: SessionID, target: string, dir: string): void {
    const listed = this.sessions
      .filter((s) => s.hostKey === hostKey && s.target === target && posix.isAbsolute(s.cwd))
      .map((s) => [s.id, s.cwd] as const);

    this.requireSeparateWorkspace(id, hostKey, target, dir, [dir], listed);
    this.reservations.set(id, { hostKey, target, dir, resolved: null, kind: 'workspace' });
  }

  // Holds a plain spawn's directory on a shared host until the session
  // lists, refusing one inside or around a directory a workspace spawn is
  // still building there: that spawn's rollback could remove it. Plain
  // spawns share directories freely, and a workspace spawn refuses one
  // around a held plain directory, so the rollback never reaches it.
  private claimPlainDir(id: SessionID, hostKey: SessionID, target: string, dir: string): void {
    if (!posix.isAbsolute(dir)) {
      return;
    }

    for (const [other, r] of this.reservations) {
      if (
        other !== id &&
        r.kind === 'workspace' &&
        r.hostKey === hostKey &&
        r.target === target &&
        [r.dir, r.resolved ?? r.dir].some((held) => isPathOverlapping(dir, held))
      ) {
        throw new DaemonError(
          'workspace_overlap',
          `${dir} overlaps ${r.dir}, where session ${other} is still building its workspace on the same host`,
          { phase: 'resolving', dir, session: other },
        );
      }
    }

    this.reservations.set(id, { hostKey, target, dir, resolved: null, kind: 'plain' });
  }

  // The directory a spawn's workspace lands in, as the readied host
  // resolves it: every later step creates, fills, and removes this
  // physical path, never the requested one. On a shared host the spawn's
  // claim is checked again against every directory as the host resolves
  // it, and records the physical path, in the turn after the last wait,
  // with the sessions listed then.
  private async claimHostDir(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
  ): Promise<string> {
    const before = this.collectHostSessionIDs(hostKey, target);

    const physical = await this.resolveHostDir(provider, hostKey, dir);
    const listed = await this.resolveListedDirs(provider, hostKey, target);

    if (this.collectHostSessionIDs(hostKey, target) !== before) {
      return this.claimHostDir(provider, id, hostKey, target, dir);
    }

    const reservation = this.reservations.get(id);

    if (reservation !== undefined) {
      this.requireSeparateWorkspace(id, hostKey, target, dir, [dir, physical], listed);

      reservation.resolved = physical;
    }

    return physical;
  }

  // Removes the physical directory a failed spawn claimed, and resolves to
  // whether it did. It removes nothing while the directory, as the host
  // resolves it in the turn after the last wait, holds the directory of a
  // listed session or of another spawn's claim, or once the directory no
  // longer resolves to itself on the host; the directory then stays for an
  // operator to remove.
  private async removeClaimedDir(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
  ): Promise<boolean> {
    if (!this.hasHostLifecycle(target)) {
      const removed = await provider.runCommand({ argv: ['rm', '-rf', '--', dir], cwd: '/' });

      return removed.exitCode === 0;
    }

    const before = this.collectHostSessionIDs(hostKey, target);

    const listed = await this.resolveListedDirs(provider, hostKey, target);

    if (this.collectHostSessionIDs(hostKey, target) !== before) {
      return this.removeClaimedDir(provider, id, hostKey, target, dir);
    }

    const holds = this.collectOtherWorkspaceDirs(id, hostKey, target, listed).some(([, other]) =>
      isPathWithin(other, dir),
    );

    if (holds) {
      return false;
    }

    const removed = await provider.runCommand({
      argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', dir, `${dir}\nx`],
      cwd: '/',
      host: hostKey,
    });

    return removed.exitCode === 0;
  }

  // The ids of the sessions listed on a host and of the plain spawns still
  // starting there, as one string a later read compares against.
  private collectHostSessionIDs(hostKey: SessionID, target: string): string {
    return [
      ...this.sessions.filter((s) => s.hostKey === hostKey && s.target === target).map((s) => s.id),
      ...this.collectPlainDirs(hostKey, target).map(([id]) => id),
    ].join(' ');
  }

  // The directories plain spawns still starting on a host hold, as given.
  private collectPlainDirs(hostKey: SessionID, target: string): (readonly [SessionID, string])[] {
    return [...this.reservations]
      .filter(([, r]) => r.kind === 'plain' && r.hostKey === hostKey && r.target === target)
      .map(([id, r]) => [id, r.dir] as const);
  }

  private requireSeparateWorkspace(
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
    forms: readonly string[],
    listed: readonly (readonly [SessionID, string])[],
  ): void {
    const other = this.collectOtherWorkspaceDirs(id, hostKey, target, listed).find(([, path]) =>
      forms.some((form) => isPathOverlapping(form, path)),
    );

    if (other !== undefined) {
      throw new DaemonError(
        'workspace_overlap',
        `${dir} overlaps ${other[1]}, the directory of session ${other[0]} on the same host; a workspace there lands beside it`,
        { phase: 'resolving', dir, session: other[0] },
      );
    }
  }

  // The directories other sessions on a host hold: the listed ones given,
  // and every other spawn's reservation in each form it has.
  private collectOtherWorkspaceDirs(
    id: SessionID,
    hostKey: SessionID,
    target: string,
    listed: readonly (readonly [SessionID, string])[],
  ): (readonly [SessionID, string])[] {
    const dirs = [...listed];

    for (const [other, r] of this.reservations) {
      if (other !== id && r.hostKey === hostKey && r.target === target) {
        dirs.push([other, r.dir], [other, r.resolved ?? r.dir]);
      }
    }

    return dirs;
  }

  // The directory of every session listed on a host, and of every plain
  // spawn still starting there, as the host resolves it, and its own
  // absolute form; a relative directory the host can no
  // longer enter is left out, since no harness can run there.
  private async resolveListedDirs(
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<(readonly [SessionID, string])[]> {
    const onHost = [
      ...this.sessions.filter((s) => s.hostKey === hostKey && s.target === target),
      ...this.collectPlainDirs(hostKey, target).map(([id, cwd]) => ({ id, cwd })),
    ];

    const resolved = await Promise.all(
      onHost.map(async (s) => {
        const dir = await this.resolveHostDir(provider, hostKey, s.cwd).catch(() => null);

        const dirs: (readonly [SessionID, string])[] = [];

        if (posix.isAbsolute(s.cwd)) {
          dirs.push([s.id, s.cwd]);
        }

        if (dir !== null) {
          dirs.push([s.id, dir]);
        }

        return dirs;
      }),
    );

    return resolved.flat();
  }

  // A directory on a host with every symlink in it resolved: an absolute
  // one through its nearest existing directory, and a relative one as a
  // harness started in it sees it, since impd resolves both alike.
  private async resolveHostDir(
    provider: ExecutionProvider,
    hostKey: SessionID,
    dir: string,
  ): Promise<string> {
    const absolute = posix.isAbsolute(dir);

    const result = await provider.runCommand({
      argv: ['sh', '-c', RESOLVE_DIR_SCRIPT, 'sh', absolute ? posix.normalize(dir) : '.'],
      cwd: absolute ? '/' : dir,
      host: hostKey,
    });

    const split = result.stdout.lastIndexOf('\0');

    if (result.exitCode !== 0 || split < 1 || result.stdout[split - 1] !== '\n') {
      throw new DaemonError(
        'host_unavailable',
        `the host of session ${hostKey} cannot resolve ${dir}: ${result.stderr.trim()}`,
        { phase: 'resolving', dir },
      );
    }

    const existing = result.stdout.slice(0, split - 1);
    const rest = result.stdout.slice(split + 1);

    return existing === '/' ? rest || '/' : `${existing}${rest}`;
  }

  // Materializes a spawn's workspace, readying its host once the source
  // resolves, or after the workspace for a directory that runs as it
  // stands. A failure once the host is ready takes it back.
  private async materializeOnSpawnHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
    targetIdentity: string,
    materialize: SpawnMaterializer,
    setupHost: () => Promise<HarnessSetup>,
  ): Promise<{ readonly setup: HarnessSetup; readonly materialized: MaterializedSpawn | null }> {
    const readied: { setup: HarnessSetup | null } = { setup: null };

    try {
      const materialized = await materialize(
        {
          readyHost: async () => {
            readied.setup = await setupHost();

            const landing = this.hasHostLifecycle(target)
              ? await this.claimHostDir(provider, id, hostKey, target, dir)
              : dir;

            return { host: hostKey, dir: landing };
          },
          removeClaim: (landing) => this.removeClaimedDir(provider, id, hostKey, target, landing),
        },
        targetIdentity,
      );

      readied.setup ??= await setupHost();

      return { setup: readied.setup, materialized };
    } catch (error) {
      if (readied.setup !== null) {
        await this.destroyFailedSpawnHost(provider, id, hostKey, readied.setup.attemptID);
      }

      throw error;
    }
  }

  // Takes back the host a spawn readied when the spawn fails before its
  // session lists: an attempt that provisioned the host takes back its imp
  // and binding, and a host of the spawn's own without one is destroyed. A
  // parent's host stays as it is. A take-back that fails throws, and a
  // destroy that fails throws that the host may still stand.
  private async destroyFailedSpawnHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> {
    if (attemptID !== null) {
      await this.tryRemoveAuthAttempt(provider, hostKey, attemptID);

      return;
    }

    if (hostKey === id && provider.capabilities.destroy) {
      try {
        await provider.destroyHost(hostKey);
      } catch (error) {
        throw new EffectRemainsError(
          `spawn of session ${id} failed and destroying its host failed too`,
          { cause: error },
        );
      }
    }
  }

  // Takes back what a spawn attempt bound when the spawn fails before its
  // session lists; a take-back that cannot be confirmed throws.
  private async tryRemoveAuthAttempt(
    provider: ExecutionProvider,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> {
    const host = provider.brokerAuth;

    if (attemptID === null || host === undefined || this.authBinder === null) {
      return;
    }

    await this.authBinder.removeAttempt(host, hostKey, attemptID);
  }

  // Waits for a revived harness behind the broker to start. A refused start
  // already ended the harness; the host goes back to sleep when no other
  // harness runs there, and the refusal is thrown.
  private async waitForAuthStart(
    s: Session,
    provider: ExecutionProvider,
    pty: HarnessHandle,
  ): Promise<void> {
    try {
      await pty.waitForStart?.();
    } catch (error) {
      if (this.isHostIdle(s.hostKey, s.target) && provider.capabilities.suspend) {
        await this.trySuspendIdleHost(provider, s.hostKey, s.target);
      }

      throw error;
    }
  }

  // Whether no harness runs on a host and no launch is readying it.
  private isHostIdle(hostKey: SessionID, target: string): boolean {
    return (
      !this.readying.has(hostKey) &&
      !this.sessions.some(
        (other) => other.hostKey === hostKey && other.target === target && other.pty !== null,
      )
    );
  }

  private async trySuspendIdleHost(
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<void> {
    try {
      await provider.suspendHost(hostKey, () => this.isHostIdle(hostKey, target));
    } catch (error) {
      this.log(
        `atc could not put the host of session ${hostKey} back to sleep after a refused start (${error instanceof Error ? error.message : String(error)})`,
      );

      return;
    }

    for (const onHost of this.sessions) {
      if (onHost.hostKey === hostKey && this.findProvider(onHost) === provider) {
        this.updateSuspended(onHost);
      }
    }

    this.emitChange();
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
  // there first. Every refusal comes before the harness starts. A harness
  // behind the broker has its binding created or verified before the host
  // is readied, and a binding this call created is taken back when a later
  // step fails; the attempt that created it comes back with the plan.
  private setupHarness(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    options: SpawnOptions,
    auth: HarnessAuthSetup | null,
  ): Promise<{ readonly plan: HarnessPlan; readonly attemptID: string | null }> {
    return this.withHostReadying(hostKey, () =>
      this.setupHarnessOnHost(adapter, provider, id, hostKey, target, options, auth),
    );
  }

  // Counts a host as readying while run runs, so it is not idle then.
  private async withHostReadying<T>(hostKey: SessionID, run: () => Promise<T>): Promise<T> {
    this.readying.set(hostKey, (this.readying.get(hostKey) ?? 0) + 1);

    try {
      return await run();
    } finally {
      const left = (this.readying.get(hostKey) ?? 1) - 1;

      if (left === 0) {
        this.readying.delete(hostKey);
      } else {
        this.readying.set(hostKey, left);
      }
    }
  }

  private async setupHarnessOnHost(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    options: SpawnOptions,
    auth: HarnessAuthSetup | null,
  ): Promise<{ readonly plan: HarnessPlan; readonly attemptID: string | null }> {
    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    if (auth === null) {
      await this.requireUnboundHost(adapter.id, hostKey);
    }

    if (!provider.remote) {
      await provider.prepareHost({
        host: hostKey,
        daemonID: this.store.daemonID,
        isIdle: () => this.isHostIdle(hostKey, target),
      });

      return {
        plan: { ...adapter.planSpawn(options), env: {}, admission: null },
        attemptID: null,
      };
    }

    const guest = provider.guest ?? { dir: '/tmp/atc', atc: null };
    const dir = `${guest.dir}/sessions/${id}`;

    const paths: GuestPaths =
      auth === null
        ? { atc: guest.atc, dir }
        : {
            atc: guest.atc,
            dir,
            auth: await this.planGuestAuth(hostKey, auth.mode, auth.binding.placeholderEnv),
          };

    const plan =
      adapter.planGuestSpawn === undefined
        ? { ...adapter.planSpawn(options), files: {} }
        : adapter.planGuestSpawn(options, paths);

    if (plan === null) {
      throw auth === null
        ? buildGuestRefusal(provider.kind, adapter.id, target, guest.atc === null)
        : new DaemonError(
            'auth_target_unsupported',
            `agent '${adapter.id}' plans no guest settings to take its credential from impd's broker on target '${target}'`,
            { agent: adapter.id, target, problem: 'no_guest_plan' },
          );
    }

    const env = plan.env ?? {};

    requireGuestEnv(adapter.id, target, env, auth !== null);

    const attemptID = await this.applyHarnessAuth(hostKey, target, auth);

    try {
      await this.setupGuest(adapter, provider, hostKey, target, dir, plan.files);
    } catch (error) {
      await this.tryRemoveAuthAttempt(provider, hostKey, attemptID);

      throw error;
    }

    const admission =
      auth === null || paths.auth === undefined
        ? null
        : { revision: paths.auth.revision, hash: auth.binding.hash, attemptID };

    return { plan: { bin: plan.bin, args: plan.args, env, admission }, attemptID };
  }

  // The part of a harness spec that keeps a launch behind the broker: the
  // requirement impd checks, and the admission each request needs from
  // the host's binding when it goes out.
  private buildBrokerSpec(
    hostKey: SessionID,
    admission: HarnessPlan['admission'],
  ): Pick<HarnessSpec, 'requireBroker' | 'admit'> {
    if (admission === null) {
      return {};
    }

    const binder = this.requireAuthBinder();

    return {
      requireBroker: true,
      admit: (kind, send) => binder.withLaunchAdmission(hostKey, admission, kind, send),
    };
  }

  // A launch without runtime auth never starts on a host that holds a
  // binding, whatever its state: the imp may hold grants atc could not
  // confirm gone, and only a rebind or a forget of the host clears it.
  private async requireUnboundHost(agent: string, hostKey: SessionID): Promise<void> {
    const held = this.authBinder === null ? null : await this.authBinder.findBinding(hostKey);

    if (held !== null) {
      throw new DaemonError(
        'auth_rebind_required',
        `agent '${agent}' takes no credential from impd's broker, but its host holds a runtime auth binding; rebind the session or forget it`,
        { agent, state: held.state },
      );
    }
  }

  // The binding revision and placeholders a guest plan behind the broker
  // launches under: the next host's first revision, or the revision the
  // shared host holds.
  private async planGuestAuth(
    hostKey: SessionID,
    mode: HarnessAuthSetup['mode'],
    placeholderEnv: Readonly<Record<string, string>>,
  ): Promise<NonNullable<GuestPaths['auth']>> {
    const held = mode === 'create' ? null : await this.requireAuthBinder().findBinding(hostKey);

    return { revision: held?.revision ?? 1, env: placeholderEnv };
  }

  // Creates the binding of a host a spawn provisions, or verifies the one
  // a revive or a sub-session launches under, and returns the attempt
  // that created it, null for a verify or no auth.
  private async applyHarnessAuth(
    hostKey: SessionID,
    target: string,
    auth: HarnessAuthSetup | null,
  ): Promise<string | null> {
    if (auth === null) {
      return null;
    }

    const binder = this.requireAuthBinder();

    if (auth.mode === 'verify') {
      await binder.verifyBinding(auth.host, hostKey, auth.binding);

      return null;
    }

    return binder.createBinding(auth.host, {
      hostKey,
      target,
      targetIdentity: auth.targetIdentity,
      binding: auth.binding,
    });
  }

  // Readies a remote host and the files a guest plan reads there, after
  // the agent's sign-in check.
  private async setupGuest(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
    dir: string,
    planned: Readonly<Record<string, string>>,
  ): Promise<void> {
    await provider.prepareHost({
      host: hostKey,
      daemonID: this.store.daemonID,
      installATC: adapter.planGuestSpawn !== undefined,
      isIdle: () => this.isHostIdle(hostKey, target),
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

    const files = Object.entries(planned).map(([path, content]) => ({ path, content }));

    if (files.length > 0) {
      await provider.transferArchive(buildTarArchive(files), dir, hostKey);
    }
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
  // confirmed stays listed, so the spawn's caller can still find it, and
  // no revive starts it until its process is found gone. A session that
  // never registered is left alone.
  async removeFailedSpawn(id: SessionID): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return;
    }

    const pty = s.pty;

    this.rollingBack.add(id);

    try {
      if (pty !== null) {
        await this.killFailedSpawn(id, pty);
      }

      // A harness other than the killed one would outlive the rollback.
      if (s.pty !== null && s.pty !== pty) {
        throw new Error(`session ${id} started another harness while its spawn rolled back`);
      }

      s.pty = null;

      this.remove(s);
      this.emitChange();

      await this.writeFleet();
      await this.removeSpawnBinding(s);
    } finally {
      this.rollingBack.delete(id);
    }
  }

  // Takes back the binding a failed spawn provisioned for its own host,
  // while it is still the spawn's attempt.
  private async removeSpawnBinding(s: Session): Promise<void> {
    const provider = this.findProvider(s);
    const held = s.hostKey === s.id ? await this.authBinder?.findBinding(s.id) : null;

    if (provider === null || held === null || held === undefined || held.state !== 'provisioning') {
      return;
    }

    await this.tryRemoveAuthAttempt(provider, s.id, held.attemptID);
  }

  // Kills a failed spawn's harness and waits for its exit. A kill that
  // throws or an exit it cannot confirm leaves the harness recorded as
  // possibly running, which blocks revives of the session.
  private async killFailedSpawn(id: SessionID, pty: HarnessHandle): Promise<void> {
    this.unconfirmedKills.set(id, pty);
    pty.kill();

    const exited = await this.waitForKilledExit(pty);

    if (!exited) {
      throw new Error(`session ${id} did not exit after its kill`);
    }

    this.unconfirmedKills.delete(id);
  }

  // Waits for a killed harness to exit, ending it with a signal it cannot
  // ignore when the first wait runs out and its provider can send one.
  private async waitForKilledExit(pty: HarnessHandle): Promise<boolean> {
    const exited = await pty.waitForExit(FAILED_SPAWN_EXIT_WAIT_MS);

    if (exited) {
      return true;
    }

    if (pty.killForced === undefined) {
      return false;
    }

    pty.killForced();

    return pty.waitForExit(FAILED_SPAWN_EXIT_WAIT_MS);
  }

  // Whether a failed spawn's rollback leaves the session free to revive:
  // none is running, and any process it killed is gone now. A session whose
  // killed process may still run stays blocked until a later check finds it
  // gone.
  private async isRollbackSettled(id: SessionID): Promise<boolean> {
    if (this.rollingBack.has(id)) {
      return false;
    }

    const killed = this.unconfirmedKills.get(id);

    if (killed !== undefined) {
      const gone = await killed.waitForExit(0);

      if (!gone) {
        return false;
      }

      this.unconfirmedKills.delete(id);
    }

    return true;
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
  // confirmed forget. The set is taken before the first await, so a
  // sub-session spawned while the kill waits on a host is not part of it.
  async kill(id: SessionID): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    const children = this.collectChildren(id);

    if (s.pty) {
      await this.stopHarness(s);

      for (const child of children) {
        if (this.sessions.includes(child) && child.parent === id) {
          await this.tryStopHarness(child);
        }
      }
    } else {
      if (this.findProvider(s)?.capabilities.destroy === true) {
        throw new DaemonError(
          'confirmation_required',
          `forgetting session ${id} destroys its host on target '${s.target}'; confirm it with session.forget`,
          { session: id },
        );
      }

      this.removeWithChildren(s, children);
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
   * throws before anything is forgotten. The sub-sessions it may forget are
   * taken before the first await; one spawned while the forget waits on a
   * host becomes top-level.
   */
  async forget(id: SessionID): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    const children = this.collectChildren(id);
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
      const bound =
        this.authBinder === null
          ? false
          : await this.authBinder.forgetBinding(provider.brokerAuth ?? null, s.hostKey);

      if (!bound) {
        await provider.destroyHost(s.hostKey);
      }

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

    this.removeWithChildren(s, children);

    await this.writeFleet();

    this.emitChange();

    return destroys;
  }

  /**
   * Withdraws every grant of the runtime auth binding on a session's host.
   * Launches on the host stay blocked until a rebind, and a harness that
   * runs keeps running while impd fails its later requests. Returns false
   * for no such session.
   */
  async revokeAuth(id: SessionID): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    await this.requireAuthBinder().revokeBinding(
      this.findProvider(s)?.brokerAuth ?? null,
      s.hostKey,
    );

    return true;
  }

  /**
   * Binds a session's host to its agent's current auth selection at the
   * next revision, and returns that revision, or null for no such session.
   */
  async updateAuth(id: SessionID): Promise<number | null> {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      throw new DaemonError('unsupported_operation', `no adapter for agent '${s.agent}'`, {
        agent: s.agent,
      });
    }

    const provider = this.requireExecution(s, 'spawn').provider;
    const auth = this.resolveHarnessAuth(adapter, provider, s.target);

    if (auth === null) {
      throw new DaemonError(
        'unsupported_operation',
        `agent '${s.agent}' takes no credential from impd's broker`,
        { agent: s.agent, problem: 'no_auth_selection' },
      );
    }

    const revision = await this.requireAuthBinder().updateBinding(
      auth.host,
      s.hostKey,
      auth.binding,
    );

    return revision;
  }

  private requireAuthBinder(): RuntimeAuthBinder {
    if (this.authBinder === null) {
      throw new DaemonError('unsupported_operation', 'this daemon binds no runtime auth', {
        problem: 'no_auth_binder',
      });
    }

    return this.authBinder;
  }

  // Removes a forgotten session and its dead sub-sessions, except one whose
  // own target can destroy its host: forgetting that one destroys the host,
  // which takes its own confirmed forget. Only a sub-session among the given
  // ones may go. Every sub-session that stays becomes top-level before the
  // session's removal is announced, and is announced after it, so no
  // announcement ever finds a sub-session whose parent is gone or a parent
  // standing without the sub-sessions that leave with it.
  private removeWithChildren(s: Session, forgettable: readonly Session[]): void {
    const kept: Session[] = [];
    const dropped: Session[] = [];

    for (const child of this.collectChildren(s.id)) {
      const live = child.pty !== null || (child.kind === 'headless' && child.state !== 'exited');

      if (
        live ||
        !forgettable.includes(child) ||
        this.findProvider(child)?.capabilities.destroy === true
      ) {
        child.parent = null;

        kept.push(child);
      } else {
        dropped.push(child);
      }
    }

    this.remove(s);

    for (const child of kept) {
      this.onEvent('state', child);
    }

    for (const child of dropped) {
      this.remove(child);
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

// An agent that takes its credential from impd's broker on a target that
// reaches none.
function buildBrokerTargetRefusal(agent: string, target: string): DaemonError {
  return new DaemonError(
    'auth_target_unsupported',
    `agent '${agent}' takes its credential from impd's broker, which target '${target}' does not reach`,
    { agent, target },
  );
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

// A guest plan's variables start the harness as they are, so none may be
// one atc sets for its own reporting, and behind the broker none may be a
// proxy or CA variable that would route around the broker.
function requireGuestEnv(
  agent: string,
  target: string,
  env: Readonly<Record<string, string>>,
  behindBroker: boolean,
): void {
  const own = Object.keys(env).find((key) => key.startsWith('ATC_'));

  if (own !== undefined) {
    throw new Error(`agent '${agent}' plans ${own}, which atc sets for the harness itself`);
  }

  const broker = behindBroker ? Object.keys(env).find((key) => isBrokerVariable(key)) : undefined;

  if (broker !== undefined) {
    throw new DaemonError(
      'auth_target_unsupported',
      `agent '${agent}' plans ${broker} on target '${target}', which would route around impd's broker`,
      { agent, target, problem: 'guest_env_conflict', variable: broker },
    );
  }
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

// Whether either of two directories on a host holds the other, or they are
// the same.
function isPathOverlapping(a: string, b: string): boolean {
  return isPathWithin(a, b) || isPathWithin(b, a);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = posix.relative(parent, child);

  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}
