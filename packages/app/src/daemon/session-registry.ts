import type { TargetConfigError } from '@atc/config/collect-targets';
import { LOCAL_TARGET } from '@atc/config/local-target';
import type { AgentID } from '@atc/core/agent-id';
import type { SessionID } from '@atc/core/session-id';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import type { ExecutionCapability, ExecutionProvider } from '@atc/plugin-api/execution-provider';
import { countSessionStates } from '@atc/protocol/count-session-states';
import type { DaemonError } from '@atc/protocol/daemon-error';
import { sortSessionViews } from '@atc/protocol/sort-session-views';
import { buildTargetIdentity } from '@atc/store/build-target-identity';
import type { ExecutionTarget } from './build-execution-targets';
import { findExecutionRefusal } from './find-execution-refusal';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

// The identity of the implicit `local` target, which a fleet row without a
// stored identity ran on.
export const LOCAL_TARGET_IDENTITY = buildTargetIdentity(
  LOCAL_TARGET.provider,
  LOCAL_TARGET.options,
);

// The target a session runs on and the identity it is bound to there; null
// binds a new session to the target as it stands now.
interface TargetBinding {
  readonly target: string;
  readonly targetIdentity: string | null;
}

interface SessionRegistryDeps {
  // The agent registered first, which a later adapter of the same id
  // replaces, as every later one replaces an earlier one.
  readonly fallback: AgentAdapter | null | undefined;
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
  readonly targetErrors: readonly TargetConfigError[];
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

/**
 * The sessions the daemon lists, the agents and execution targets they run
 * under, and the lookups every other session module makes on them. The
 * registry never changes after it is built, apart from the list itself.
 */
export class SessionRegistry {
  sessions: Session[] = [];

  focusedId: SessionID | null = null;

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward. Lets a hot path
  // that only cares about this answer skip walking live sessions to find it.
  readonly hasScreenDetector: boolean;

  private readonly adapters: Readonly<Record<AgentID, AgentAdapter>>;

  readonly targets: ReadonlyMap<string, ExecutionTarget>;

  readonly targetErrors: readonly TargetConfigError[];

  // Sessions a restore registered that have had neither a terminal nor a
  // headless turn since, so a later restore tries them again rather than
  // taking them for live headless runs.
  readonly unrestored = new Set<SessionID>();

  // Sessions dropped from the list on purpose whose rows the next fleet
  // write deletes; each stays here until a write carrying it lands.
  readonly removedIDs = new Set<SessionID>();

  private readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;

  constructor(deps: SessionRegistryDeps) {
    // Each adapter names the id it answers to, so a registry key can never
    // disagree with the adapter behind it. A later one wins the id.
    this.adapters = Object.fromEntries(
      [
        ...(deps.fallback === null || deps.fallback === undefined ? [] : [deps.fallback]),
        ...deps.adapters,
      ].map((a) => [a.id, a]),
    );

    this.hasScreenDetector = Object.values(this.adapters).some((a) => a.screenDetector !== null);

    this.targets = new Map(deps.targets.map((t) => [t.id, t]));

    this.targetErrors = deps.targetErrors;
    this.callbacks = deps.callbacks;
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

  // Whether a target's host has a lifecycle of its own that the daemon
  // follows: one that can sleep or be destroyed. The daemon's own machine
  // has none.
  hasHostLifecycle(target: string): boolean {
    const capabilities = this.targets.get(target)?.provider?.capabilities;

    return capabilities !== undefined && (capabilities.suspend || capabilities.destroy);
  }

  // Whether a target runs its harnesses on the daemon's own machine, where
  // each one ends with the daemon.
  isLocalTarget(target: string): boolean {
    return this.targets.get(target)?.provider?.remote === false;
  }

  // Whether the session is the caller or a session the caller sits under,
  // following each parent link the fleet holds.
  isCallerTree(id: SessionID, caller: SessionID): boolean {
    let current: SessionID | null = caller;

    const seen = new Set<SessionID>();

    while (current !== null && !seen.has(current)) {
      if (current === id) {
        return true;
      }

      seen.add(current);

      const at: SessionID = current;

      current = this.sessions.find((x) => x.id === at)?.parent ?? null;
    }

    return false;
  }

  // The live and dead sub-sessions of a session, in list order.
  collectChildren(id: SessionID): Session[] {
    return this.sessions.filter((s) => s.parent === id);
  }

  remove(s: Session) {
    this.sessions = this.sessions.filter((x) => x.id !== s.id);

    this.removedIDs.add(s.id);
    this.unrestored.delete(s.id);

    if (this.focusedId === s.id) {
      this.focusedId = null;
    }

    this.callbacks.onEvent('removed', s);
  }

  countStates() {
    return countSessionStates(this.sessions);
  }

  sortSessions(): Session[] {
    return sortSessionViews(this.sessions);
  }
}
