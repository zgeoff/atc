import { expect, test } from 'bun:test';
import type { HeadlessRunner } from '../agents/agent-adapter';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { buildStubHeadlessRunner } from '../test-utils/build-stub-headless-runner';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

interface SetupConfig {
  // The provider the daemon's one target runs its sessions on.
  readonly provider: ExecutionProvider;

  // The agent's headless runner, or null for an agent without one.
  readonly headlessRunner?: HeadlessRunner | null;

  // Each listed principal and the targets it may use, or null for none.
  readonly principals?: ReadonlyMap<string, readonly string[]> | null;

  // The clock confirm tokens are minted and checked against.
  readonly forgetClock?: () => number;
}

// A real daemon whose one target, `local`, runs on the provider the config
// wires, with an idle agent.
function setupTest(config: SetupConfig) {
  const provider = config.provider;

  return startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter({ headlessRunner: config.headlessRunner ?? null }),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: config.principals ?? null,
      forgetClock: config.forgetClock ?? Date.now,

      // An eject waits this long for the terminal to report its end before
      // the headless run starts; the idle agent never reports one.
      ejectSettleMs: 30,
    }),
  });
}

test('it answers a forget on a host-destroying target with a token and destroys nothing yet', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const clock = { now: 1_800_000_000_000 };

  await using ctx = await setupTest({ provider, forgetClock: () => clock.now });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const answer = await ctx.client.sendRequest('session.forget', { session: id });

  expect(answer).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: 1_800_000_060_000,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it destroys the host and forgets the session when the forget carries its token', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  const forgotten = await ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(provider.destroyed).toStrictEqual([id]);
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.client.sendRequest('fleet.list')).resolves.toStrictEqual({ fleet: [] });
});

test('it refuses a forget with internal and keeps the session when the host destroy fails', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  provider.setDestroyFailure(new Error('the host did not answer'));

  await using ctx = await setupTest({ provider });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  const failed = ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(failed).rejects.toMatchObject({ code: 'internal' });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it refuses a confirm token a forget already took', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  provider.setDestroyFailure(new Error('the host did not answer'));

  await ctx.client
    .sendRequest('session.forget', { session: id, confirmToken: offered['confirmToken'] })
    .catch(() => null);

  provider.setDestroyFailure(null);

  const retried = ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(retried).rejects.toMatchObject({
    code: 'confirm_token_invalid',
    data: { reason: 'used' },
  });
});

test('it refuses a confirm token past its lifetime', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const clock = { now: 1_800_000_000_000 };

  await using ctx = await setupTest({ provider, forgetClock: () => clock.now });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  clock.now += 60_000;

  const late = ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(late).rejects.toMatchObject({
    code: 'confirm_token_invalid',
    data: { reason: 'expired' },
  });

  expect(provider.destroyed).toBeEmpty();
});

test('it takes a confirm token up to the last millisecond of its lifetime', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const clock = { now: 1_800_000_000_000 };

  await using ctx = await setupTest({ provider, forgetClock: () => clock.now });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  clock.now += 59_999;

  const forgotten = await ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
});

test('it refuses a confirm token handed out for another session', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({
      kind: 'imp-like',
      capabilities: { suspend: true, destroy: true },
    }),
  });

  const first = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  const second = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const offered = await ctx.client.sendRequest('session.forget', {
    session: getRecord(first, 'session')['id'],
  });

  const crossed = ctx.client.sendRequest('session.forget', {
    session: getRecord(second, 'session')['id'],
    confirmToken: offered['confirmToken'],
  });

  expect(crossed).rejects.toMatchObject({
    code: 'confirm_token_invalid',
    data: { reason: 'unknown' },
  });
});

test('it forgets a session on the local target at once without a token', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await ctx.client.sendRequest('session.forget', { session: id });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a forget of a session the daemon does not hold', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  expect(
    ctx.client.sendRequest('session.forget', { session: 'no-such-session' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a forget that refuses a pinned session when a pin lands after the session was read', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const read = await ctx.client.sendRequest('session.get', { session: id });

  await ctx.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = ctx.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(read).toMatchObject({ session: { id, pinned: false, alive: false } });
  expect(refused).rejects.toMatchObject({ code: 'session_pinned', data: { session: id } });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true })],
  });
});

test('it refuses a forget that refuses a pinned session of a sub-session of a pinned session', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawnedParent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    parent,
  });

  const child = getRecord(spawnedChild, 'session')['id'];

  await ctx.client.sendRequest('session.update', { session: parent, pinned: true });

  const refused = ctx.client.sendRequest('session.forget', { session: child, refusePinned: true });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses a forget that refuses a live session when the session is live', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = ctx.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_live', data: { session: id } });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it forgets a dead unpinned session when the forget refuses pinned and live sessions', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const forgotten = await ctx.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a pinned session on a host-destroying target before it hands out a token', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({
      kind: 'imp-like',
      capabilities: { suspend: true, destroy: true },
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = ctx.client.sendRequest('session.forget', { session: id, refusePinned: true });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });
});

test('it keeps a headless run going when the forget of its session fails to destroy the host', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const headless = buildStubHeadlessRunner();

  provider.setDestroyFailure(new Error('impd is unreachable'));

  await using ctx = await setupTest({ provider, headlessRunner: headless.runner });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitFor(() => {
    expect(headless.runs).toHaveLength(1);
  });

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  const forgotten = ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).rejects.toMatchObject({ code: 'internal' });
  expect(headless.runs).toStrictEqual([{ request: expect.toBeObject(), stopped: false }]);

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, kind: 'headless' }],
  });
});

test('it answers a principal forget without a token of a session on a target it may not use as for a session that does not exist, destroying nothing', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider, principals: new Map([['outsider', []]]) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });

  const forgetOfHeld = ctx.client.sendRequest('session.forget', { session: id }, 'outsider');

  expect(forgetOfHeld).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: `no session '${id}'`,
    data: undefined,
  });

  expect(
    ctx.client.sendRequest('session.forget', { session: 'no-such-session' }, 'outsider'),
  ).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: "no session 'no-such-session'",
    data: undefined,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it answers a principal forget with the owner token of a session on a target it may not use as for a session that does not exist, destroying nothing', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider, principals: new Map([['outsider', []]]) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  const forgetOfHeld = ctx.client.sendRequest(
    'session.forget',
    { session: id, confirmToken: offered['confirmToken'] },
    'outsider',
  );

  expect(forgetOfHeld).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: `no session '${id}'`,
    data: undefined,
  });

  expect(
    ctx.client.sendRequest(
      'session.forget',
      { session: 'no-such-session', confirmToken: offered['confirmToken'] },
      'outsider',
    ),
  ).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: "no session 'no-such-session'",
    data: undefined,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it destroys the host when a principal that may use its target forgets with the token', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider, principals: new Map([['insider', ['local']]]) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const offered = await ctx.client.sendRequest('session.forget', { session: id }, 'insider');

  const forgotten = await ctx.client.sendRequest(
    'session.forget',
    { session: id, confirmToken: offered['confirmToken'] },
    'insider',
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(provider.destroyed).toStrictEqual([id]);
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});
