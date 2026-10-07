import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { ImpProvider } from './imp-provider';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

// A session manager whose one target `box` runs on the imp provider over a
// fixture imp port, with two stored sessions on it, each in an imp of its
// own, and the given agent.
async function setupTest(adapter: AgentAdapter) {
  const tmp = setupTempDir('atc-restore-imp-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  const port = new FixtureImpPort();

  const logged: string[] = [];

  const runtimes = new Map<string, SessionRuntime>();

  const mgr = new SessionManager(
    adapter,
    store,
    join(tmp.dir, 'status.json'),
    [],
    [
      {
        id: 'box',
        kind: 'imp',
        options: {},
        identity: 'imp:test',
        provider: new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }),
      },
    ],
  );

  mgr.log = (line) => {
    logged.push(line);
  };

  await store.writeFleet(
    ['s-first', 's-second'].map((id) => ({
      sessionID: toSessionID(id),
      name: id,
      cwd: tmp.dir,
      agentSessionID: toAgentSessionID(`agent-${id}`),
      agent: 'claude',
      target: 'box',
      targetIdentity: 'imp:test',
    })),
  );

  return {
    mgr,
    logged,
    restore: () =>
      restoreFleet({
        mgr,
        store,
        findRuntime: (id) => runtimes.get(id),
        cols: 80,
        rows: 24,
        capMs: 50,
      }),
    async [Symbol.asyncDispose]() {
      mgr.detachAll();

      await store.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

const baseAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  await using ctx = await setupTest({ ...baseAdapter, planAuthCheck: () => ['false'] });

  const restored = await ctx.restore();

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', false],
    ['s-second', false],
  ]);
});

test('it logs a later session whose revive fails and leaves it without a terminal', async () => {
  await using ctx = await setupTest({
    ...baseAdapter,
    planGuestSpawn: (_opts, guest) => {
      if (guest.dir.endsWith('s-second')) {
        throw new Error('no plan for s-second');
      }

      return { bin: 'sleep', args: ['30'], files: {} };
    },
  });

  const restored = await ctx.restore();

  expect(restored.restored).toBe(2);

  await waitFor(() => {
    expect<readonly unknown[]>(ctx.logged).toStrictEqual([
      'atc could not revive session s-second (no plan for s-second)',
    ]);
  });

  expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', true],
    ['s-second', false],
  ]);
});

test('it logs a first session whose revive fails with a plain error and still revives the next one', async () => {
  await using ctx = await setupTest({
    ...baseAdapter,
    planGuestSpawn: (_opts, guest) => {
      if (guest.dir.endsWith('s-first')) {
        throw new Error('no plan for s-first');
      }

      return { bin: 'sleep', args: ['30'], files: {} };
    },
  });

  const restored = await ctx.restore();

  expect(restored.restored).toBe(2);

  await waitFor(() => {
    expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
      ['s-first', false],
      ['s-second', true],
    ]);
  });

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    'atc could not revive session s-first (no plan for s-first)',
  ]);
});
