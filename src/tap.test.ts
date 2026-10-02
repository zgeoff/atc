import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test/setup-temp-dir';
import { spawnNamedSession } from '../test/spawn-named-session';
import { waitFor } from '../test/wait-for';
import type { AgentAdapter } from './agents/agent-adapter';
import { DaemonClient } from './client/daemon-client';
import { startDaemon } from './daemon/daemon';
import type { EventMsg } from './protocol/protocol';

// The tap subcommand against an in-process daemon: it dials the default
// daemon socket under XDG_RUNTIME_DIR, so the daemon listens exactly there.
async function setupTest() {
  const tmp = setupTempDir('atc-tap-');

  const claude: AgentAdapter = {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: true,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const daemon = await startDaemon({
    socketPath: join(tmp.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: claude,
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const events: EventMsg[] = [];

  const actor = await DaemonClient.open(join(tmp.dir, 'atc-daemon.sock'));

  actor.onEvent = (event) => {
    events.push(event);
  };

  await actor.sendHello('atc/test-build');

  let stopped = false;

  const stop = async () => {
    if (!stopped) {
      stopped = true;

      await daemon.stop();
    }
  };

  return {
    dir: tmp.dir,
    actor,
    events,
    stop,
    async [Symbol.asyncDispose]() {
      actor.stop();

      await stop();

      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it writes each pending message as an NDJSON line and acks it', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const first = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'one',
    from: 'alice',
  });

  const second = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'two',
    from: 'bob',
  });

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: daemon.dir, HOME: daemon.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    const delivered = daemon.events.filter(
      (e) => e.ev === 'SessionMessage' && e['status'] === 'delivered',
    );

    expect(delivered).toHaveLength(2);
  });

  proc.kill();

  const stdout = await new Response(proc.stdout).text();

  const lines = stdout
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(lines).toStrictEqual([
    { id: first['message'], from: 'alice', text: 'one', sentAt: expect.toBeNumber() },
    { id: second['message'], from: 'bob', text: 'two', sentAt: expect.toBeNumber() },
  ]);
}, 15_000);

test('it exits 1 with a hint when no daemon listens', async () => {
  using tmp = setupTempDir('atc-tap-empty-');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', 's1'],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: tmp.dir, HOME: tmp.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect(code).toBe(1);
  expect(stderr).toInclude('no daemon');
}, 15_000);

test('it exits 1 when the session cannot be tapped', async () => {
  await using daemon = await setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', 'nope'],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: daemon.dir, HOME: daemon.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect(code).toBe(1);
  expect(stderr).toInclude('no_such_session');
}, 15_000);

// Hangs on main's CI only; tracked in zgeoff/atc#117.
test.skip('it exits 0 once the daemon closes the connection', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: daemon.dir, HOME: daemon.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  onTestFinished(() => {
    proc.kill();
  });

  // A message reaching delivered proves the tap is connected before the
  // daemon goes away.
  await waitFor(async () => {
    await daemon.actor.sendRequest('session.message', { session: id, text: 'ping' });

    expect(daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  await daemon.stop();

  const code = await proc.exited;

  expect(code).toBe(0);
}, 15_000);

test('it exits 0 when another tap replaces it', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: daemon.dir, HOME: daemon.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  onTestFinished(() => {
    proc.kill();
  });

  // A message reaching delivered proves the tap is subscribed.
  await waitFor(async () => {
    await daemon.actor.sendRequest('session.message', { session: id, text: 'ping' });

    expect(daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  const replacement = await DaemonClient.open(join(daemon.dir, 'atc-daemon.sock'));

  onTestFinished(() => {
    replacement.stop();
  });

  await replacement.sendHello('atc/test-build');
  await replacement.sendRequest('session.tap', { session: id });

  const code = await proc.exited;

  expect(code).toBe(0);
}, 15_000);
