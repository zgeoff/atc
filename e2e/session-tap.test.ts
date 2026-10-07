import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { startDaemon } from '../src/daemon/daemon';
import type { EventMsg } from '../src/protocol/protocol';
import { buildMockAgentAdapter } from '../src/test-utils/build-mock-agent-adapter';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { spawnNamedSession } from '../src/test-utils/spawn-named-session';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A real daemon listening at the socket path the tap subcommand computes
 * from `XDG_RUNTIME_DIR`, which `env` points at the temp directory, and a
 * client that has sent its handshake and collects every event. Disposal
 * stops the client and the daemon and removes the directory.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-tap-'));

  // The tap dials this path, so the daemon listens exactly there; the
  // adapter takes messages, so a session has an inbox to tap.
  const daemon = await startDaemon({
    socketPath: join(tmp.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter({ takesMessages: true }),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  stack.defer(() => daemon.stop());

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
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it writes each pending message as an NDJSON line and acks it through atc tap', async () => {
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

  await using proc = Bun.spawn([...resolveATCCommand(), 'tap', '--session', id], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
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
