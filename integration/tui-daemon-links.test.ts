import { expect, onTestFinished, test } from 'bun:test';
import type { DaemonBoot } from '@atc/protocol';
import { buildMockAgentAdapter, buildStubClock, waitFor } from '@atc/test-utils';
import { DaemonLinkFailureError } from '@atc/tui';
import { createDaemonLinks, createFleetMirror } from '@atc/tui/testing';
import type { DaemonEvent } from '@atcx/contract';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// The TUI's links to two daemons in the test's process: the local one as the primary, and one
// that stands in for a daemon on another host.

async function setupTest() {
  const local = await startTestDaemon({ options: () => ({ adapter: buildMockAgentAdapter() }) });
  const remote = await startTestDaemon({ options: () => ({ adapter: buildMockAgentAdapter() }) });

  const clock = buildStubClock(1_000_000);
  const mirror = createFleetMirror(null);
  const events: [string | null, DaemonEvent][] = [];
  const boots = { remote: 0 };
  const failures: DaemonLinkFailureError[] = [];

  const openBoot = async (daemon: typeof local): Promise<DaemonBoot> => ({
    client: await daemon.openClient(),
    stale: false,
    lastUsedAgent: 'claude',
    socketPath: daemon.socketPath,
  });

  const links = createDaemonLinks({
    daemons: [
      {
        name: null,
        bootDaemon: () => openBoot(local),
        restartDaemon: () => Promise.resolve(false),
        listingCache: { readListing: () => null, writeListing: () => Promise.resolve() },
      },
      {
        name: 'box',
        bootDaemon: () => {
          boots.remote += 1;

          const failure = failures.shift();

          return failure === undefined ? openBoot(remote) : Promise.reject(failure);
        },
        listingCache: { readListing: () => null, writeListing: () => Promise.resolve() },
      },
    ],
    clock,
    mirror,
    onEvent: (daemon, event) => {
      events.push([daemon, event]);
    },
    readAgents: () => Promise.resolve(),
    logEvent: () => {},
  });

  onTestFinished(links.stop);

  const primaryBoot = await openBoot(local);

  links.setPrimary({ kind: 'up' }, primaryBoot);

  const spawn = async (daemon: typeof local, name: string) => {
    await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      agent: 'claude',
      name,
      cols: 80,
      rows: 24,
    });
  };

  return { local, remote, clock, mirror, events, boots, failures, links, spawn };
}

test('it brings a remote daemon up with its sessions in the mirror, and the primary stays up', async () => {
  const ctx = await setupTest();

  await ctx.spawn(ctx.remote, 'on-the-box');

  ctx.links.openRemotes();

  await waitFor(() => {
    expect(ctx.links.stateOf('box')).toStrictEqual({ kind: 'up' });
  });

  expect({
    sessions: ctx.mirror.sessions.map((session) => [session.daemon, session.name]),
    up: ctx.links.upDaemons(),
    agent: ctx.links.lastUsedAgent('box'),
  }).toStrictEqual({ sessions: [['box', 'on-the-box']], up: [null, 'box'], agent: 'claude' });
});

test('it reaches each daemon through its own client', async () => {
  const ctx = await setupTest();

  await ctx.spawn(ctx.local, 'here');
  await ctx.spawn(ctx.remote, 'there');

  ctx.links.openRemotes();

  await waitFor(() => {
    expect(ctx.links.stateOf('box').kind).toBe('up');
  });

  const listOf = async (daemon: string | null) => {
    const listed = await ctx.links.clientFor(daemon)?.sendRequest('session.list');

    return listed?.['sessions'];
  };

  expect([await listOf(null), await listOf('box')]).toStrictEqual([
    [expect.objectContaining({ name: 'here' })],
    [expect.objectContaining({ name: 'there' })],
  ]);
});

test("it routes a remote daemon's events to that daemon", async () => {
  const ctx = await setupTest();

  ctx.links.openRemotes();

  await waitFor(() => {
    expect(ctx.links.stateOf('box').kind).toBe('up');
  });

  await ctx.spawn(ctx.remote, 'late-one');

  await waitFor(() => {
    expect(ctx.events).toSatisfyAny(
      ([daemon, event]) => daemon === 'box' && event.ev === 'SessionAdded',
    );
  });
});

test('it gives no client and keeps the rows while the remote daemon is down, then replaces the rows once it is back', async () => {
  const ctx = await setupTest();

  await ctx.spawn(ctx.remote, 'survivor');

  ctx.links.openRemotes();

  await waitFor(() => {
    expect(ctx.links.stateOf('box').kind).toBe('up');
  });

  await ctx.remote.stop();

  ctx.clock.advance(0);

  await waitFor(() => {
    expect(ctx.links.stateOf('box').kind).toBe('down');
  });

  const whileDown = {
    client: ctx.links.clientFor('box'),
    rows: ctx.mirror.sessions.map((session) => session.name),
    local: ctx.links.stateOf(null),
  };

  await ctx.remote.restart();
  await ctx.spawn(ctx.remote, 'after-restart');

  await waitFor(() => {
    ctx.clock.advance(2000);

    expect(ctx.links.stateOf('box').kind).toBe('up');
  });

  expect({
    whileDown,
    rows: ctx.mirror.sessions.map((session) => session.name).toSorted(),
  }).toStrictEqual({
    whileDown: { client: null, rows: ['survivor'], local: { kind: 'up' } },
    rows: ['after-restart'],
  });
});

test.each([
  { kind: 'unauthorized', message: 'daemon box refused the token' },
  { kind: 'mismatched', message: 'daemon atc/7.14.0 speaks v14' },
] as const)(
  'it holds the state $kind and boots again every 30 seconds until the daemon accepts',
  async (row) => {
    const ctx = await setupTest();

    ctx.failures.push(
      new DaemonLinkFailureError(row.kind, row.message),
      new DaemonLinkFailureError(row.kind, row.message),
    );

    ctx.links.openRemotes();

    await waitFor(() => {
      expect(ctx.links.stateOf('box')).toStrictEqual({ kind: row.kind, detail: row.message });
    });

    const first = ctx.boots.remote;

    ctx.clock.advance(29_000);

    const early = ctx.boots.remote;

    ctx.clock.advance(1000);

    await waitFor(() => {
      expect(ctx.boots.remote).toBe(first + 1);
    });

    ctx.clock.advance(30_000);

    await waitFor(() => {
      expect(ctx.links.stateOf('box')).toStrictEqual({ kind: 'up' });
    });

    expect({ early, first }).toStrictEqual({ early: first, first });
  },
);

test('it reports a daemon that cannot be reached as down with the failure text', async () => {
  const ctx = await setupTest();

  ctx.failures.push(
    new DaemonLinkFailureError('down', "cannot reach daemon 'box' at 127.0.0.1:1: ECONNREFUSED"),
  );

  ctx.links.openRemotes();

  await waitFor(() => {
    expect(ctx.links.stateOf('box')).toStrictEqual({
      kind: 'down',
      detail: "cannot reach daemon 'box' at 127.0.0.1:1: ECONNREFUSED",
    });
  });
});
