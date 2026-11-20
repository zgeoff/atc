import type { TargetConfigError } from '@atc/config';
import { LOCAL_TARGET } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { AgentAdapter, ExecutionCapability, ExecutionProvider } from '@atc/plugin-api';
import type { SessionState } from '@atc/protocol';
import { countSessionStates, sortSessionViews } from '@atc/protocol';
import { buildTargetIdentity } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { AtcError } from '@atcx/contract/light';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { findExecutionRefusal } from '../fleet/find-execution-refusal';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

export const LOCAL_TARGET_IDENTITY = buildTargetIdentity(
  LOCAL_TARGET.provider,
  LOCAL_TARGET.options,
);

export interface TargetBinding {
  readonly target: string;
  readonly targetIdentity: string | null;
}

interface SessionRegistryDeps {
  readonly fallback: AgentAdapter | null | undefined;
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
  readonly targetErrors: readonly TargetConfigError[];
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

export interface SessionRegistry {
  sessions: Session[];

  focusedId: SessionID | null;

  readonly hasScreenDetector: boolean;

  readonly targets: ReadonlyMap<string, ExecutionTarget>;

  readonly unrestored: Set<SessionID>;

  readonly removedIDs: Set<SessionID>;

  readonly requireExecution: (
    binding: Readonly<TargetBinding>,
    capability: ExecutionCapability,
  ) => { readonly provider: ExecutionProvider; readonly identity: string };

  readonly findExecutionRefusal: (
    binding: Readonly<{ target: string | null; targetIdentity: string | null }>,
    capability: ExecutionCapability,
  ) => AtcError | null;

  readonly findProvider: (session: Session) => ExecutionProvider | null;

  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  readonly collectAdapters: () => AgentAdapter[];

  readonly hasHostLifecycle: (target: string) => boolean;

  readonly isLocalTarget: (target: string) => boolean;

  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;

  readonly collectChildren: (id: SessionID) => Session[];

  readonly remove: (session: Session) => void;
  readonly countStates: () => Record<SessionState, number>;
  readonly sortSessions: () => Session[];
}

export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
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

    // A daemon knows every state it holds, so the status file keeps the four counts it always had.
    countStates: () => {
      const counts = countSessionStates(registry.sessions);

      return {
        needs_you: counts.needs_you,
        running: counts.running,
        done: counts.done,
        exited: counts.exited,
      };
    },

    sortSessions: () => sortSessionViews(registry.sessions),
  };

  return registry;
}
