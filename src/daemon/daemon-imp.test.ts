import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubEchoClaude } from '../test-utils/create-stub-echo-claude';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { readJSONRecord } from '../test-utils/read-json-record';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

// A real daemon whose one target `box` runs on the imp provider over a
// stub imp port, with the daemon id its lease labels carry.
async function setupTest() {
  const port = createStubImpPort();

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-',
    options: (paths) => {
      // Every session runs this agent, which prints its pid, echoes each
      // line it reads with its pid, and exits 3 on `quit`, so a test sees
      // which process took its input.
      const fakeClaude = createStubEchoClaude(paths.dir);

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

  return {
    client: daemon.client,
    events: daemon.events,
    dir: daemon.dir,
    dbPath: daemon.dbPath,
    socketPath: daemon.socketPath,
    build: daemon.build,
    logs: daemon.logs,
    port,
  };
}

test('it logs how long each step of a spawn on an imp took', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  const id = String(getRecord(spawned, 'session')['id']);

  expect<readonly unknown[]>(
    ctx.logs.filter((line) => line.startsWith('atc: spawn of session')),
  ).toStrictEqual([
    expect.stringMatching(
      new RegExp(
        String.raw`^atc: spawn of session ${id} on target 'box' took features \d+, inspect-imp \d+, create-imp \d+, lease \d+, guest-atc \d+, record \d+, harness-start \d+, total \d+$`,
      ),
    ),
  ]);
});

test('it logs how long each step of a wake on an imp took', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect<readonly unknown[]>(
    ctx.logs.filter((line) => line.startsWith('atc: wake of session')),
  ).toStrictEqual([
    expect.stringMatching(
      new RegExp(
        String.raw`^atc: wake of session ${id} on target 'box' took features \d+, inspect-imp \d+, lease \d+, guest-atc \d+, record \d+, harness-start \d+, total \d+$`,
      ),
    ),
  ]);
});

test('it starts each top-level session in an imp of its own', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  expect(ctx.port.collectImpNames()).toHaveLength(2);
});

test("it runs a sub-session in its parent's imp", async () => {
  const ctx = await setupTest();

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
  const ctx = await setupTest();
  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

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
    `leases.acquire ${imp} atc-${String(hello['daemonID'])}`,
    `leases.release ${imp} atc-${String(hello['daemonID'])}`,
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
  const ctx = await setupTest();
  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

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
    `leases.acquire ${imp} atc-${String(hello['daemonID'])}`,
    `leases.release ${imp} atc-${String(hello['daemonID'])}`,
    `leases.acquire ${imp} atc-${String(hello['daemonID'])}`,
  ]);

  expect(ctx.port.findState(String(imp))).toBe('running');

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, state: 'running', alive: true }],
  });
});

test('it keeps the imp of a session when a forget carries no confirm token', async () => {
  const ctx = await setupTest();

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
  const ctx = await setupTest();

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
  const ctx = await setupTest();

  updateEnv('ATC_TEST_DAEMON_CANARY', 'daemon-only');
  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'fixture-not-a-secret');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const spawnedID = String(getRecord(spawned, 'session')['id']);
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_BRIDGE: '1',
    ATC_OUTBOX: expect.stringMatching(new RegExp(`^${ctx.dir}/g/run/[0-9a-f]{16}\\.outbox$`)),
    ATC_SESSION_ID: getRecord(spawned, 'session')['id'],
    ATC_SESSION_RECORD: join(ctx.dir, 'g', 'records', `${spawnedID}.json`),
    ATC_SOCKET: expect.stringMatching(new RegExp(`^${ctx.dir}/g/run/[0-9a-f]{16}\\.sock$`)),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a remote harness with only the variables atc sets, never the daemon environment', async () => {
  const ctx = await setupTest();
  const store = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => store.stop());

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

    invariant(sent?.kind === 'start', 'the restore has sent no start request yet');

    return sent;
  });

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_BRIDGE: '1',
    ATC_OUTBOX: join(ctx.dir, 'g', 'run', '0f1e2d3c4b5a6978.outbox'),
    ATC_SESSION_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    ATC_SESSION_RECORD: join(ctx.dir, 'g', 'records', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.json'),
    ATC_SOCKET: join(ctx.dir, 'g', 'run', '0f1e2d3c4b5a6978.sock'),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a slept session inside the same process by waking its imp', async () => {
  const ctx = await setupTest();

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

    invariant(match?.groups?.['pid'] !== undefined, 'the harness has not started');

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
  const ctx = await setupTest();
  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.input', { session: id, d: 'quit\r' });

  await waitFor(() => {
    expect(ctx.port.calls).toContain(`leases.release ${imp} atc-${String(hello['daemonID'])}`);
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
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  await waitFor(() => {
    expect(ctx.port.getEnd(String(imp), request.session)).toBeGreaterThan(0);
  });

  ctx.port.stopConnection(String(imp), request.session, 1011);

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
  const ctx = await setupTest();

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
  const ctx = await setupTest();

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

    invariant(match?.groups?.['pid'] !== undefined, 'the harness has not started');

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
  const ctx = await setupTest();
  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

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
      ctx.port.calls.filter(
        (call) => call === `leases.release ${imp} atc-${String(hello['daemonID'])}`,
      ),
    ).toHaveLength(2);
  });
});

test('it revives a session that woke its imp even when a sibling on that imp cannot revive', async () => {
  const ctx = await setupTest();

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

test('it places a read-only copy of the session record inside the imp before the harness starts', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(ctx.dir, 'g', 'records', `${id}.json`);
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  expect(request.env['ATC_SESSION_RECORD']).toBe(path);
  expect(statSync(path).mode & 0o777).toBe(0o444);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: id,
    daemonID: expect.any(String),
    target: 'box',
    revision: 1,
    updatedAt: expect.any(String),
    scope: {
      workspace: { path: ctx.dir, branch: null, repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it rewrites the copy inside the imp when a caller adds to the scope', async () => {
  const ctx = await setupTest();
  const fixture = await createGitFixture({ prefix: 'atc-daemon-imp-record-' });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: fixture.work,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const added = await ctx.client.sendRequest('session.scope.add', {
    session: id,
    scope: { branches: [{ name: 'main' }] },
  });

  const record = getRecord(added, 'record');
  const path = join(ctx.dir, 'g', 'records', `${id}.json`);

  expect(record['revision']).toBe(2);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual(record);
  expect(statSync(path).mode & 0o777).toBe(0o444);
});
