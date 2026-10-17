import type { AgentID, SessionID } from '@atc/core';
import type { AgentAdapter, SpawnOptions } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';

interface StubHarnessAdapterConfig {
  // The adapter's id; `claude` when absent.
  readonly id?: AgentID;

  // The events each hook event name means, keyed by the name; a name the
  // table lacks means one heartbeat.
  readonly hooks?: Readonly<Record<string, readonly Readonly<AdapterEvent>[]>>;

  // Whether sessions take inbox messages; false when absent.
  readonly takesMessages?: boolean;
}

interface StubHookRead {
  readonly hook: HookEvent;
  readonly prev: unknown;
}

export interface StubHarnessAdapter extends AgentAdapter {
  // Every spawn planned, in order, with the session it starts.
  readonly spawns: { readonly opts: SpawnOptions; readonly session?: SessionID }[];

  // Every hook line read, in order.
  readonly hookReads: StubHookRead[];
}

export function buildStubHarnessAdapter(config: StubHarnessAdapterConfig = {}): StubHarnessAdapter {
  const spawns: { opts: SpawnOptions; session?: SessionID }[] = [];
  const hookReads: StubHookRead[] = [];
  const hooks = config.hooks ?? {};

  return {
    id: config.id ?? 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: config.takesMessages ?? false,
    spawns,
    hookReads,
    planSpawn: (opts, session) => {
      const spawn = session === undefined ? { opts } : { opts, session };

      spawns.push(spawn);

      // only an in-memory host starts this binary
      return { bin: 'stub-harness', args: [] };
    },
    planHookEvents: (hook, prev) => {
      hookReads.push({ hook, prev });

      return {
        events: hooks[hook.event] ?? [{ kind: 'heartbeat' }],

        // the state counts the lines the harness reported since it booted, so a test
        // can tell which state the daemon kept for which session
        next: (typeof prev === 'number' ? prev : 0) + 1,
      };
    },
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };
}
