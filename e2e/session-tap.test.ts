import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  registerTestCleanup,
  resolveATCCommand,
  setupTempDir,
  spawnNamedSession,
  waitFor,
} from '@atc/test-utils';
import type { DaemonEvent } from '@atcx/contract';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-tap-');

  // The tap dials this path, so the daemon listens exactly there; the
  // adapter takes messages, so a session has an inbox to tap.
  const daemon = await startDaemon({
    socketPath: join(temporaryDirectory.path, 'atc-daemon.sock'),
    reporterSocketPath: join(temporaryDirectory.path, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter({ takesMessages: true }),
    targets: [buildLocalTarget()],
    dbPath: join(temporaryDirectory.path, 'state.db'),
    statusPath: join(temporaryDirectory.path, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  const events: DaemonEvent[] = [];

  const actor = await openDaemonClient(join(temporaryDirectory.path, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    actor.stop();
  });

  actor.onEvent = (event) => {
    events.push(event);
  };

  await actor.sendHello('atc/test-build');

  return {
    directory: temporaryDirectory.path,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: temporaryDirectory.path,
      HOME: temporaryDirectory.path,
    },
    actor,
    events,
  };
}

test('it writes each pending message as an NDJSON line and acks it through atc tap', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.actor.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const first = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  const subprocess = Bun.spawn([...resolveATCCommand(), 'tap', '--session', id], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  await waitFor(() => {
    expect(
      ctx.events.filter(
        (daemonEvent) => daemonEvent.ev === 'SessionMessage' && daemonEvent.status === 'delivered',
      ),
    ).toHaveLength(2);
  });

  subprocess.kill();

  const stdout = await new Response(subprocess.stdout).text();

  expect(
    stdout
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line)),
  ).toStrictEqual([
    {
      id: first['message'],
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      text: 'one',
      sentAt: expect.toBeNumber(),
    },
    {
      id: second['message'],
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      text: 'two',
      sentAt: expect.toBeNumber(),
    },
  ]);
});
