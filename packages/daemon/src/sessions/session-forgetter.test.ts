import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, buildStubLog, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { ConfirmTokens } from './confirm-tokens';
import { SessionForgetter } from './session-forgetter';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

interface SetupTestConfig {
  // Whether the target's provider can destroy a session's host.
  readonly destroy: boolean;
}

// A session manager on one `local` target over the in-memory provider, a
// real state store, and the forgetter over them with tokens on a stopped
// clock; each session the manager announces gets the runtime the daemon
// gives it.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-forgetter-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    capabilities: { suspend: config.destroy, destroy: config.destroy },
  });

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [buildStubHarnessAdapter()],
    [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    [],
    {
      onEvent: (kind, s) => {
        if (kind === 'added') {
          runtimes.set(s.id, new SessionRuntime());
        }
      },
    },
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  // A destroy logs the host it removed.
  mgr.log = buildStubLog().log;

  const forgetter = new SessionForgetter({
    mgr,
    findRuntime: (id) => runtimes.get(id),
    tokens: new ConfirmTokens({ now: () => clock.now(), lifetimeMs: 60_000 }),
  });

  return { dir: tmp.dir, provider, mgr, runtimes, forgetter };
}

test('it forgets a session at once on a target that cannot destroy its host', async () => {
  const ctx = await setupTest({ destroy: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.forgetter.killSession(s.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    s.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(ctx.mgr.sessions).toBeEmpty();
});

test('it answers a forget on a host-destroying target with a token and destroys nothing', async () => {
  const ctx = await setupTest({ destroy: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.forgetter.killSession(s.id, false);

  const answer = await ctx.forgetter.forgetSession(
    s.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(answer).toMatchObject({ expiresAt: 1_060_000 });
  expect(ctx.provider.destroyed).toBeEmpty();
  expect(ctx.mgr.sessions).toHaveLength(1);
});

test('it destroys the host and forgets the session when the forget carries its token', async () => {
  const ctx = await setupTest({ destroy: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.forgetter.killSession(s.id, false);

  const answer = await ctx.forgetter.forgetSession(
    s.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  invariant(typeof answer === 'object' && 'confirmToken' in answer);

  const forgotten = await ctx.forgetter.forgetSession(
    s.id,
    answer.confirmToken,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect(ctx.provider.destroyed).toHaveLength(1);
});

test('it refuses a pinned session when the caller asks it to', async () => {
  const ctx = await setupTest({ destroy: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.pinned = true;

  const forgotten = ctx.forgetter.forgetSession(
    s.id,
    undefined,
    { pinned: true, live: false },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is pinned/);
});

test('it forgets a sub-session of a pinned session when its parent asks', async () => {
  const ctx = await setupTest({ destroy: false });
  const parent = await ctx.mgr.spawn(ctx.dir, 'lead', '', 80, 24);

  const child = await ctx.mgr.spawn(
    ctx.dir,
    'helper',
    '',
    80,
    24,
    false,
    'auto',
    'claude',
    parent.id,
  );

  parent.pinned = true;

  await ctx.forgetter.killSession(child.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    child.id,
    undefined,
    { pinned: true, live: false },
    parent.id,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
});

test('it refuses a sub-session of a pinned session that another caller asks to forget', async () => {
  const ctx = await setupTest({ destroy: false });
  const parent = await ctx.mgr.spawn(ctx.dir, 'lead', '', 80, 24);

  const child = await ctx.mgr.spawn(
    ctx.dir,
    'helper',
    '',
    80,
    24,
    false,
    'auto',
    'claude',
    parent.id,
  );

  parent.pinned = true;

  const forgotten = ctx.forgetter.forgetSession(
    child.id,
    undefined,
    { pinned: true, live: false },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is pinned/);
});

test('it refuses a live session when the caller asks it to', async () => {
  const ctx = await setupTest({ destroy: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const forgotten = ctx.forgetter.forgetSession(
    s.id,
    undefined,
    { pinned: false, live: true },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is live/);
});

test('it answers a forget of a session the manager does not hold as missing', async () => {
  const ctx = await setupTest({ destroy: false });

  const forgotten = await ctx.forgetter.forgetSession(
    toSessionID('s-gone'),
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toBe('missing');
});

test('it stops a live session that a kill asks to stop', async () => {
  const ctx = await setupTest({ destroy: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);
  const outcome = await ctx.forgetter.killSession(s.id, true);

  expect(outcome).toBe('stopped');
  expect(s.pty).toBeNull();
});

test('it answers a kill of a session the manager does not hold as missing', async () => {
  const ctx = await setupTest({ destroy: false });

  expect(ctx.forgetter.killSession(toSessionID('s-gone'), false)).resolves.toBe('missing');
});

test('it stops the headless run of a session a kill ends', async () => {
  const ctx = await setupTest({ destroy: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const runtime = ctx.runtimes.get(s.id);

  invariant(runtime);

  const stop = mock<() => void>();

  runtime.headlessRun = { stop };

  await ctx.forgetter.killSession(s.id, true);

  expect(stop).toHaveBeenCalledOnce();
});
