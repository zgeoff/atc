import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { buildStubHeadlessRunner } from '../test-utils/build-stub-headless-runner';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

test('it answers a forget on a host-destroying target with a token and destroys nothing yet', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const clock = { now: 1_800_000_000_000 };

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      forgetClock: () => clock.now,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const answer = await daemon.client.sendRequest('session.forget', { session: id });

  expect(answer).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: 1_800_000_060_000,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it destroys the host and forgets the session when the forget carries its token', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const forgotten = await daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(provider.destroyed).toStrictEqual([id]);
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(daemon.client.sendRequest('fleet.list')).resolves.toStrictEqual({ fleet: [] });
});

test('it refuses a forget with internal and keeps the session when the host destroy fails', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  provider.setDestroyFailure(new Error('the host did not answer'));

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const failed = daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(failed).rejects.toMatchObject({ code: 'internal' });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it refuses a confirm token a forget already took', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  provider.setDestroyFailure(new Error('the host did not answer'));

  await daemon.client
    .sendRequest('session.forget', { session: id, confirmToken: offered['confirmToken'] })
    .catch(() => null);

  provider.setDestroyFailure(null);

  const retried = daemon.client.sendRequest('session.forget', {
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

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      forgetClock: () => clock.now,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  clock.now += 60_000;

  const late = daemon.client.sendRequest('session.forget', {
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

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      forgetClock: () => clock.now,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  clock.now += 59_999;

  const forgotten = await daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
});

test('it refuses a confirm token handed out for another session', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const offered = await daemon.client.sendRequest('session.forget', {
    session: getRecord(first, 'session')['id'],
  });

  const crossed = daemon.client.sendRequest('session.forget', {
    session: getRecord(second, 'session')['id'],
    confirmToken: offered['confirmToken'],
  });

  expect(crossed).rejects.toMatchObject({
    code: 'confirm_token_invalid',
    data: { reason: 'unknown' },
  });
});

test('it forgets a session on the local target at once without a token', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await daemon.client.sendRequest('session.forget', { session: id });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a forget of a session the daemon does not hold', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  expect(
    daemon.client.sendRequest('session.forget', { session: 'no-such-session' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a forget that refuses a pinned session when a pin lands after the session was read', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.get', { session: id });
  await daemon.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned', data: { session: id } });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true })],
  });
});

test('it refuses a forget that refuses a pinned session of a sub-session of a pinned session', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawnedParent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    parent,
  });

  const child = getRecord(spawnedChild, 'session')['id'];

  await daemon.client.sendRequest('session.update', { session: parent, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', {
    session: child,
    refusePinned: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses a forget that refuses a live session when the session is live', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_live', data: { session: id } });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it forgets a dead unpinned session when the forget refuses pinned and live sessions', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const forgotten = await daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a pinned session on a host-destroying target before it hands out a token', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', { session: id, refusePinned: true });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });
});

test('it keeps a headless run going when the forget of its session fails to destroy the host', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const headless = buildStubHeadlessRunner();

  provider.setDestroyFailure(new Error('impd is unreachable'));

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,

        // Every hook reads as the terminal's end, so one fires the pending
        // eject.
        normalizeHook: () => ({ kind: 'ended' }),
      }),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.eject', { session: id });
  await daemon.sendHookLines({ atcId: id, event: 'SessionEnd', payload: {} });

  await waitFor(() => {
    expect(headless.runs).toHaveLength(1);
  });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const forgotten = daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).rejects.toMatchObject({ code: 'internal' });

  expect<readonly unknown[]>(
    headless.runs.map((run) => ({ request: run.request, stopped: run.stopped })),
  ).toStrictEqual([
    {
      request: {
        cwd: daemon.dir,
        prompt:
          'Continue the task autonomously. Verify your work as you go and stop when it is complete.',
        resume: 'agent-1',
        sessionID: id,
      },
      stopped: false,
    },
  ]);

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, kind: 'headless' }],
  });
});

test('it refuses a principal forget without a token of a session on a target it may not use as a session that does not exist, destroying nothing', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', []]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });

  const refused = daemon.client.sendRequest('session.forget', { session: id }, 'outsider');

  expect(refused).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: `no session '${id}'`,
    data: undefined,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it refuses a principal forget without a token of a session that does not exist', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', []]]),
    }),
  });

  const refused = daemon.client.sendRequest(
    'session.forget',
    { session: 'no-such-session' },
    'outsider',
  );

  expect(refused).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: "no session 'no-such-session'",
    data: undefined,
  });
});

test('it refuses a principal forget with the owner token of a session on a target it may not use as a session that does not exist, destroying nothing', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', []]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const refused = daemon.client.sendRequest(
    'session.forget',
    { session: id, confirmToken: offered['confirmToken'] },
    'outsider',
  );

  expect(refused).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: `no session '${id}'`,
    data: undefined,
  });

  expect(provider.destroyed).toBeEmpty();

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it refuses a principal forget with the owner token of a session that does not exist', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', []]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const refused = daemon.client.sendRequest(
    'session.forget',
    { session: 'no-such-session', confirmToken: offered['confirmToken'] },
    'outsider',
  );

  expect(refused).rejects.toMatchObject({
    name: 'DaemonError',
    code: 'no_such_session',
    message: "no session 'no-such-session'",
    data: undefined,
  });
});

test('it destroys the host when a principal that may use its target forgets with the token', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['insider', ['local']]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id }, 'insider');

  const forgotten = await daemon.client.sendRequest(
    'session.forget',
    { session: id, confirmToken: offered['confirmToken'] },
    'insider',
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(provider.destroyed).toStrictEqual([id]);
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});
