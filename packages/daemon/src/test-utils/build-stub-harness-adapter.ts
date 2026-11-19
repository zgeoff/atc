import type { AgentID } from '@atc/core';
import type { AgentAdapter, SpawnOptions } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { SessionID } from '@atcx/contract';

interface StubHarnessAdapterConfig {
  readonly id?: AgentID;

  readonly hooks?: Readonly<Record<string, readonly Readonly<AdapterEvent>[]>>;

  readonly takesMessages?: boolean;
}

interface StubHookRead {
  readonly hook: HookEvent;
  readonly previous: unknown;
}

export interface StubHarnessAdapter extends AgentAdapter {
  readonly spawns: { readonly opts: SpawnOptions; readonly session?: SessionID }[];

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

      return { bin: 'stub-harness', args: [] };
    },
    planHookEvents: (hook, previous) => {
      hookReads.push({ hook, previous });

      return {
        events: hooks[hook.event] ?? [{ kind: 'heartbeat' }],

        next: (typeof previous === 'number' ? previous : 0) + 1,
      };
    },
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    planResumeCommand: () => null,
  };
}
