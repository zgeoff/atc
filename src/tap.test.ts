import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from './client/daemon-client';
import { startDaemon } from './daemon/daemon';
import type { DaemonHandle } from './daemon/daemon';
import type { EventMsg } from './protocol/protocol';
import { buildMockAgentAdapter } from './test-utils/build-mock-agent-adapter';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { spawnNamedSession } from './test-utils/spawn-named-session';
import { waitFor } from './test-utils/wait-for';

/**
 * A real daemon listening at the socket path the tap subcommand computes
 * from `XDG_RUNTIME_DIR`, which `env` points at the temp directory, and a
 * client that has sent its handshake and collects every event. `stop`
 * stops the daemon once; disposal stops the client and the daemon and
 * removes the directory.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-tap-'));

  // The tap dials this path, so the daemon listens exactly there; the
  // adapter takes messages, so a session has an inbox to tap.
  let live: DaemonHandle | null = await startDaemon({
    socketPath: join(tmp.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter({ takesMessages: true }),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const stop = async () => {
    const stopping = live;

    live = null;

    await stopping?.stop();
  };

  stack.defer(stop);

  const events: EventMsg[] = [];

  const actor = await DaemonClient.open(join(tmp.dir, 'atc-daemon.sock'));

  stack.defer(() => {
    actor.stop();
  });

  actor.onEvent = (event) => {
    events.push(event);
  };

  await actor.sendHello('atc/test-build');

  const owned = stack.move();

  return {
    dir: tmp.dir,
    env: { ...process.env, XDG_RUNTIME_DIR: tmp.dir, HOME: tmp.dir },
    actor,
    events,
    stop,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it writes each pending message as an NDJSON line and acks it', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession((m, p) => ctx.actor.sendRequest(m, p), 'one', ctx.dir);

  const first = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'one',
    from: 'alice',
  });

  const second = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'two',
    from: 'bob',
  });

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    { env: ctx.env, stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(
      ctx.events.filter((e) => e.ev === 'SessionMessage' && e['status'] === 'delivered'),
    ).toHaveLength(2);
  });

  proc.kill();

  const stdout = await new Response(proc.stdout).text();

  expect(
    stdout
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line)),
  ).toStrictEqual([
    { id: first['message'], from: 'alice', text: 'one', sentAt: expect.toBeNumber() },
    { id: second['message'], from: 'bob', text: 'two', sentAt: expect.toBeNumber() },
  ]);
});

test('it exits 1 with a hint when no daemon listens', async () => {
  await using tmp = setupTempDir('atc-tap-empty-');

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

  expect({ code, stderr }).toStrictEqual({
    code: 1,
    stderr: `atc tap: no daemon at ${join(tmp.dir, 'atc-daemon.sock')} — start atc first\n`,
  });
});

test('it exits 1 with the refusal when the session cannot be tapped', async () => {
  await using ctx = await setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', 'nope'],
    { env: ctx.env, stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect({ code, stderr }).toStrictEqual({
    code: 1,
    stderr: "atc tap: no_such_session: no session 'nope'\n",
  });
});

test('it exits 0 once the daemon closes the connection', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession((m, p) => ctx.actor.sendRequest(m, p), 'one', ctx.dir);

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    { env: ctx.env, stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    proc.kill();
  });

  await ctx.actor.sendRequest('session.message', { session: id, text: 'ping' });

  // A message reaching delivered proves the tap is connected before the
  // daemon goes away.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  await ctx.stop();

  const code = await proc.exited;

  expect(code).toBe(0);
});

test('it exits 0 when another tap replaces it', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession((m, p) => ctx.actor.sendRequest(m, p), 'one', ctx.dir);

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', id],
    { env: ctx.env, stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    proc.kill();
  });

  await ctx.actor.sendRequest('session.message', { session: id, text: 'ping' });

  // A message reaching delivered proves the tap is subscribed.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  const replacement = await DaemonClient.open(join(ctx.dir, 'atc-daemon.sock'));

  onTestFinished(() => {
    replacement.stop();
  });

  await replacement.sendHello('atc/test-build');
  await replacement.sendRequest('session.tap', { session: id });

  const code = await proc.exited;

  expect(code).toBe(0);
});
