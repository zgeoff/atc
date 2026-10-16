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

/**
 * One hook line the adapter read: the line, and the state the daemon passed
 * back with it.
 */
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

/**
 * An agent adapter for daemon tests on the in-memory provider: every spawn
 * plans the `stub-harness` binary with no arguments, which only an
 * in-memory host starts, and is recorded with its session. Each hook line
 * is recorded with the state the daemon passed back, and means the events
 * the config's table holds for its event name. The state it returns is the
 * count of lines the session's harness has reported since it booted, so a
 * test reads from `hookReads` which state the daemon kept for which
 * session. No name, no resume command, no headless runner, no screen
 * detector, and every optional member absent.
 */
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
    planHookEvents: (hook, prev) => {
      hookReads.push({ hook, prev });

      return {
        events: hooks[hook.event] ?? [{ kind: 'heartbeat' }],
        next: (typeof prev === 'number' ? prev : 0) + 1,
      };
    },
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };
}
