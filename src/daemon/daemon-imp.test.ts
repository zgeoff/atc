import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

// A real daemon whose one target `box` runs on the imp provider over a
// fixture imp port, with the daemon id its lease labels carry.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const port = stack.use(buildStubImpPort());

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-',
    options: (paths) => {
      // Every session runs this agent, which prints its pid, echoes each
      // line it reads with its pid, and exits 3 on `quit`, so a test sees
      // which process took its input.
      const fakeClaude = createStubBin(
        paths.dir,
        'fake-claude',
        `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line:$$"
done
`,
      );

      return {
        adapter: buildMockAgentAdapter({ planSpawn: () => ({ bin: fakeClaude, args: [] }) }),
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: new ImpProvider(
              port,
              { guestDir: join(paths.dir, 'g') },
              { reconnectDelaysMs: [0, 0, 0] },
            ),
          },
        ],
        defaultTarget: 'box',
      };
    },
  });

  stack.use(daemon);

  const probe = await DaemonClient.open(daemon.socketPath);

  stack.defer(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(daemon.build);

  const owned = stack.move();

  return {
    client: daemon.client,
    events: daemon.events,
    dir: daemon.dir,
    dbPath: daemon.dbPath,
    port,
    daemonID: String(hello['daemonID']),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it starts each top-level session in an imp of its own', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  expect(ctx.port.collectImpNames()).toHaveLength(2);
});

test("it runs a sub-session in its parent's imp", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  const names = ctx.port.collectImpNames();

  expect(names).toHaveLength(1);

  expect<readonly unknown[]>(ctx.port.sessionRequests.map((request) => request.name)).toStrictEqual(
    [names[0], names[0]],
  );
});

test('it releases its own lease before it puts the imp of a killed session to sleep', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.kill', { session: id });

  expect(
    ctx.port.calls.filter((call) => call.startsWith('leases.') || call.startsWith('imps.sleep')),
  ).toStrictEqual([
    `leases.acquire ${imp} atc-${ctx.daemonID}`,
    `leases.release ${imp} atc-${ctx.daemonID}`,
    `imps.sleep ${imp}`,
  ]);

  expect(ctx.port.findState(String(imp))).toBe('sleeping');

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [
      {
        id,
        state: 'exited',
        lastMsg: 'asleep',
        lifecycle: { desired: 'sleep', vm: 'asleep', harness: 'suspended', attachment: 'detached' },
      },
    ],
  });
});

test('it keeps a session running and takes its lease back when another owner leases the imp', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  ctx.port.acquireOtherLease(String(imp), 'token:other', 'build', 60);

  const killed = ctx.client.sendRequest('session.kill', { session: id });

  expect(killed).rejects.toMatchObject({
    code: 'host_leased',
    data: { leases: [], otherCount: 1 },
  });

  expect(ctx.port.calls.filter((call) => call.startsWith('leases.'))).toStrictEqual([
    `leases.acquire ${imp} atc-${ctx.daemonID}`,
    `leases.release ${imp} atc-${ctx.daemonID}`,
    `leases.acquire ${imp} atc-${ctx.daemonID}`,
  ]);

  expect(ctx.port.findState(String(imp))).toBe('running');

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, state: 'running', alive: true }],
  });
});

test('it keeps the imp of a session when a forget carries no confirm token', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.forget', { session: id });

  expect(ctx.port.collectImpNames()).toHaveLength(1);
});

test('it destroys the imp of a session once a forget carries its confirm token', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  await ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(ctx.port.collectImpNames()).toBeEmpty();
});

test('it starts a remote harness with only the variables atc sets, never the daemon environment', async () => {
  await using ctx = await setupTest();

  updateEnv('ATC_TEST_DAEMON_CANARY', 'daemon-only');
  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'fixture-not-a-secret');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const [request] = ctx.port.sessionRequests;

  if (request?.kind !== 'start') {
    throw new Error('the spawn sent no start request');
  }

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_BRIDGE: '1',
    ATC_OUTBOX: expect.stringMatching(new RegExp(`^${ctx.dir}/g/run/[0-9a-f]{16}\\.outbox$`)),
    ATC_SESSION_ID: getRecord(spawned, 'session')['id'],
    ATC_SOCKET: expect.stringMatching(new RegExp(`^${ctx.dir}/g/run/[0-9a-f]{16}\\.sock$`)),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a remote harness with only the variables atc sets, never the daemon environment', async () => {
  await using ctx = await setupTest();

  const store = await StateStore.open(ctx.dbPath);

  onTestFinished(() => store.stop());

  await store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  updateEnv('ATC_TEST_DAEMON_CANARY', 'daemon-only');
  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'fixture-not-a-secret');

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const request = await waitFor(() => {
    const [sent] = ctx.port.sessionRequests;

    if (sent?.kind !== 'start') {
      throw new Error('the restore has sent no start request yet');
    }

    return sent;
  });

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_BRIDGE: '1',
    ATC_OUTBOX: join(ctx.dir, 'g', 'run', '0f1e2d3c4b5a6978.outbox'),
    ATC_SESSION_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    ATC_SOCKET: join(ctx.dir, 'g', 'run', '0f1e2d3c4b5a6978.sock'),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a slept session inside the same process by waking its imp', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const output = ctx.events
      .filter((event) => event.ev === 'SessionOutput')
      .map((event) => String(event['d']))
      .join('');

    const match = /UP:(?<pid>\d+)/.exec(output);

    if (match?.groups?.['pid'] === undefined) {
      throw new Error('the harness has not started');
    }

    return match.groups['pid'];
  });

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.input', { session: id, d: 'again\r' });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude(`GOT:again:${pid}`);
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [
      {
        id,
        state: 'running',
        lifecycle: { desired: 'run', vm: 'awake', harness: 'running', attachment: 'attached' },
      },
    ],
  });
});

test('it leaves a session whose harness exited by itself restorable and gives its lease back', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.input', { session: id, d: 'quit\r' });

  await waitFor(() => {
    expect(ctx.port.calls).toContain(`leases.release ${imp} atc-${ctx.daemonID}`);
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [
      {
        id,
        state: 'exited',
        lastMsg: 'process exited',
        lifecycle: { desired: 'run', vm: 'awake', harness: 'exited', attachment: 'detached' },
      },
    ],
  });

  expect(ctx.port.findState(String(imp))).toBe('running');
});

test('it lists a session as reattaching while its connection is lost and as attached once it resumes', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();
  const [request] = ctx.port.sessionRequests;

  await waitFor(() => {
    expect(ctx.port.getEnd(String(imp), String(request?.session))).toBeGreaterThan(0);
  });

  ctx.port.stopConnection(String(imp), String(request?.session), 1011);

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => getRecord(getRecord(event, 'session'), 'lifecycle')['attachment']),
    ).toStrictEqual(['reattaching', 'attached']);
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, state: 'running', alive: true }],
  });
});

test('it lists a session whose imp another owner put to sleep as asleep', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude('UP:');
  });

  ctx.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [
        {
          id,
          state: 'exited',
          lastMsg: 'asleep',
          lifecycle: { vm: 'asleep', harness: 'suspended', attachment: 'detached' },
        },
      ],
    });
  });
});

test('it revives a session whose imp another owner put to sleep in the same process', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const match = /UP:(?<pid>\d+)/.exec(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    );

    if (match?.groups?.['pid'] === undefined) {
      throw new Error('the harness has not started');
    }

    return match.groups['pid'];
  });

  ctx.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, lastMsg: 'asleep' }] });
  });

  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.input', { session: id, d: 'again\r' });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude(`GOT:again:${pid}`);
  });
});

test('it gives its lease back when a session it revived from sleep exits', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.input', { session: id, d: 'quit\r' });

  await waitFor(() => {
    expect(
      ctx.port.calls.filter((call) => call === `leases.release ${imp} atc-${ctx.daemonID}`),
    ).toHaveLength(2);
  });
});

test('it revives a session that woke its imp even when a sibling on that imp cannot revive', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-parent',
  });

  const parentID = getRecord(parent, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-child',
    parent: parentID,
  });

  const childID = getRecord(child, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: parentID });

  ctx.port.setAcquireFailure(1, 'UNAVAILABLE');

  await ctx.client.sendRequest('session.adopt', { session: parentID, cols: 80, rows: 24 });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [
      { id: parentID, state: 'running' },
      { id: childID, state: 'exited', lastMsg: 'asleep' },
    ],
  });
});
