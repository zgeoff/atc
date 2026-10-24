import type { TargetConfigError } from '@atc/config';
import { LOCAL_TARGET } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { AgentAdapter, ExecutionCapability, ExecutionProvider } from '@atc/plugin-api';
import type { SessionState } from '@atc/protocol';
import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonError } from '@atc/protocol/wire';
import { buildTargetIdentity } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { findExecutionRefusal } from '../fleet/find-execution-refusal';
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
export interface TargetBinding {
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

export interface SessionRegistry {
  sessions: Session[];

  focusedId: SessionID | null;

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward. Lets a hot path
  // that only cares about this answer skip walking live sessions to find it.
  readonly hasScreenDetector: boolean;

  readonly targets: ReadonlyMap<string, ExecutionTarget>;

  // Sessions a restore registered that have had neither a terminal nor a
  // headless turn since, so a later restore tries them again rather than
  // taking them for live headless runs.
  readonly unrestored: Set<SessionID>;

  // Sessions dropped from the list on purpose whose rows the next fleet
  // write deletes; each stays here until a write carrying it lands.
  readonly removedIDs: Set<SessionID>;

  readonly requireExecution: (
    binding: Readonly<TargetBinding>,
    capability: ExecutionCapability,
  ) => { readonly provider: ExecutionProvider; readonly identity: string };

  // The refusal for running work of a capability on a binding's target, or
  // null when the target serves it. A null target is a spawn that names
  // none when the config gives no default, which is always refused.
  readonly findExecutionRefusal: (
    binding: Readonly<{ target: string | null; targetIdentity: string | null }>,
    capability: ExecutionCapability,
  ) => DaemonError | null;

  // The provider a session's harness runs on, or null when its target is
  // gone from the config or has no provider here.
  readonly findProvider: (session: Session) => ExecutionProvider | null;

  // never falls back to another id: a session whose agent is not registered
  // is unsupported, not somebody else's spawn
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  // Every registered adapter, one per id, in registration order.
  readonly collectAdapters: () => AgentAdapter[];

  // Whether a target's host has a lifecycle of its own that the daemon
  // follows: one that can sleep or be destroyed. The daemon's own machine
  // has none.
  readonly hasHostLifecycle: (target: string) => boolean;

  // Whether a target runs its harnesses on the daemon's own machine, where
  // each one ends with the daemon.
  readonly isLocalTarget: (target: string) => boolean;

  // Whether the session is the caller or a session the caller sits under,
  // following each parent link the fleet holds.
  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;

  // The live and dead sub-sessions of a session, in list order.
  readonly collectChildren: (id: SessionID) => Session[];

  readonly remove: (session: Session) => void;
  readonly countStates: () => Record<SessionState, number>;
  readonly sortSessions: () => Session[];
}

export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  // Each adapter names the id it answers to, so a registry key can never
  // disagree with the adapter behind it. A later one wins the id.
  const adapters: Readonly<Record<AgentID, AgentAdapter>> = Object.fromEntries(
    [
      ...(deps.fallback === null || deps.fallback === undefined ? [] : [deps.fallback]),
      ...deps.adapters,
    ].map((adapter) => [adapter.id, adapter]),
  );

  const targets: ReadonlyMap<string, ExecutionTarget> = new Map(
    deps.targets.map((target) => [target.id, target]),
  );

  const targetErrors = deps.targetErrors;
  const callbacks = deps.callbacks;

  const registry: SessionRegistry = {
    sessions: [],

    focusedId: null,

    hasScreenDetector: Object.values(adapters).some((adapter) => adapter.screenDetector !== null),

    targets,

    unrestored: new Set<SessionID>(),

    removedIDs: new Set<SessionID>(),

    requireExecution: (binding, capability) => {
      const refusal = registry.findExecutionRefusal(binding, capability);
      const target = targets.get(binding.target);

      if (refusal !== null) {
        throw refusal;
      }

      if (target === undefined || target.provider === null) {
        throw new Error(
          `execution target '${binding.target}' passed its checks without a provider`,
        );
      }

      return { provider: target.provider, identity: target.identity };
    },

    findExecutionRefusal: (binding, capability) =>
      findExecutionRefusal(targets, targetErrors, binding, capability),

    findProvider: (session) => targets.get(session.target)?.provider ?? null,

    findAdapter: (id) => adapters[id] ?? null,

    collectAdapters: () => Object.values(adapters),

    hasHostLifecycle: (target) => {
      const capabilities = targets.get(target)?.provider?.capabilities;

      return capabilities !== undefined && (capabilities.suspend || capabilities.destroy);
    },

    isLocalTarget: (target) => targets.get(target)?.provider?.remote === false,

    isCallerTree: (id, caller) => {
      let current: SessionID | null = caller;

      const seen = new Set<SessionID>();

      while (current !== null && !seen.has(current)) {
        if (current === id) {
          return true;
        }

        seen.add(current);

        const at: SessionID = current;

        current = registry.sessions.find((x) => x.id === at)?.parent ?? null;
      }

      return false;
    },

    collectChildren: (id) => registry.sessions.filter((session) => session.parent === id),

    remove: (session) => {
      registry.sessions = registry.sessions.filter((x) => x.id !== session.id);

      registry.removedIDs.add(session.id);
      registry.unrestored.delete(session.id);

      if (registry.focusedId === session.id) {
        registry.focusedId = null;
      }

      callbacks.onEvent('removed', session);
    },

    countStates: () => countSessionStates(registry.sessions),

    sortSessions: () => sortSessionViews(registry.sessions),
  };

  return registry;
}
