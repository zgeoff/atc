import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { startDaemon } from '../src/daemon/daemon';
import type { EventMsg } from '../src/protocol/protocol';
import { buildMockAgentAdapter } from '../src/test-utils/build-mock-agent-adapter';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { spawnNamedSession } from '../src/test-utils/spawn-named-session';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A real daemon listening at the socket path the tap subcommand computes
 * from `XDG_RUNTIME_DIR`, which `env` points at the temp directory, and a
 * client that has sent its handshake and collects every event. The client,
 * the daemon, and the directory are released once the test finishes.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-e2e-tap-');

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

  registerTestCleanup(() => daemon.stop());

  const events: EventMsg[] = [];

  const actor = await DaemonClient.open(join(tmp.dir, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    actor.stop();
  });

  actor.onEvent = (event) => {
    events.push(event);
  };

  await actor.sendHello('atc/test-build');

  return {
    dir: tmp.dir,
    env: { ...process.env, XDG_RUNTIME_DIR: tmp.dir, HOME: tmp.dir },
    actor,
    events,
  };
}

test('it writes each pending message as an NDJSON line and acks it through atc tap', async () => {
  const ctx = await setupTest();
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

  const proc = Bun.spawn([...resolveATCCommand(), 'tap', '--session', id], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(async () => {
    proc.kill();

    await proc.exited;
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
