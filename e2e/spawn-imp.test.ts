import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@atc/config';
import { toSessionID } from '@atc/core';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort, getOnlyImpName } from '@atc/execution-imp/testing';
import { LocalPTYProvider } from '@atc/execution-local';
import { openDaemonClient } from '@atc/protocol/client';
import { StateStore, buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  createGitFixture,
  createStubEchoClaude,
  getRecord,
  readJSONRecord,
  registerTestCleanup,
  updateEnv,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

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
      const fakeClaude = createStubEchoClaude(paths.directory);

      return {
        adapter: buildMockAgentAdapter({
          takesMessages: true,
          planSpawn: () => ({ bin: fakeClaude, args: [] }),
        }),
        targets: [
          {
            id: LOCAL_TARGET.id,
            kind: LOCAL_TARGET.provider,
            options: LOCAL_TARGET.options,
            identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
            provider: new LocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: new ImpProvider(
              port,
              { guestDir: join(paths.directory, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
        ],
        defaultTarget: 'box',

        // A restore tries a refused session again at once, so a test of
        // that retry waits on no real delay.
        restoreRetryDelaysMs: [0],
      };
    },
  });

  return {
    client: daemon.client,
    events: daemon.events,
    directory: daemon.directory,
    dbPath: daemon.dbPath,
    socketPath: daemon.socketPath,
    build: daemon.build,
    logs: daemon.logs,
    openClient: daemon.openClient,
    sendHookLines: daemon.sendHookLines,
    restart: daemon.restart,
    port,
  };
}

test('it logs how long each step of a spawn on an imp took', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.directory });

  const id = String(getRecord(spawned, 'session')['id']);

  expect<readonly unknown[]>(
    ctx.logs.filter((line) => line.startsWith('atc: spawn of session')),
  ).toStrictEqual([
    expect.stringMatching(
      new RegExp(
        String.raw`^atc: spawn of session ${id} on target 'box' took impd-version \d+, inspect-imp \d+, create-imp \d+, lease \d+, guest-atc \d+, record \d+, harness-start \d+, total \d+$`,
        'u',
      ),
    ),
  ]);
});

test('it logs how long each step of a wake on an imp took', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
        String.raw`^atc: wake of session ${id} on target 'box' took impd-version \d+, inspect-imp \d+, lease \d+, guest-atc \d+, record \d+, harness-start \d+, total \d+$`,
        'u',
      ),
    ),
  ]);
});

test('it starts each top-level session in an imp of its own', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.directory, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.spawn', { cwd: ctx.directory, cols: 80, rows: 24 });

  expect(ctx.port.collectImpNames()).toHaveLength(2);
});

test("it runs a sub-session in its parent's imp", async () => {
  const ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
  const probe = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
  const probe = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
    cwd: ctx.directory,
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
    cwd: ctx.directory,
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
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const spawnedID = String(getRecord(spawned, 'session')['id']);
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_BRIDGE: '1',
    ATC_OUTBOX: expect.stringMatching(
      new RegExp(`^${ctx.directory}/g/run/[0-9a-f]{16}\\.outbox$`, 'u'),
    ),
    ATC_SESSION_ID: getRecord(spawned, 'session')['id'],
    ATC_SESSION_RECORD: join(ctx.directory, 'g', 'records', `${spawnedID}.json`),
    ATC_SOCKET: expect.stringMatching(
      new RegExp(`^${ctx.directory}/g/run/[0-9a-f]{16}\\.sock$`, 'u'),
    ),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it restores a cloud session that was mid-turn at a daemon restart and delivers its wake message after its imp refused the first try', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  const turn = await ctx.client.sendRequest('session.message', { session: id, text: 'work' });
  const turnTap = await ctx.openClient();

  await turnTap.sendRequest('session.tap', { session: id });
  await turnTap.sendRequest('message.ack', { session: id, message: turn['message'] });

  ctx.port.setAcquireFailure(0, 'SERVICE_UNAVAILABLE');

  await ctx.restart();

  const client = await ctx.openClient();

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: true, kind: 'pty' });
  });

  const wake = await client.sendRequest('session.message', { session: id, text: 'wake up' });
  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });

  const acked = await tap.sendRequest('message.ack', { session: id, message: wake['message'] });

  expect(acked).toStrictEqual({ message: wake['message'], status: 'delivered' });

  expect(ctx.logs).toContain(
    `atc could not revive session ${String(id)} (imp ${ctx.port.collectImpNames()[0]} cannot be used: impd refused the lease (SERVICE_UNAVAILABLE)); trying again`,
  );
});

test('it revives a remote harness with only the variables atc sets, never the daemon environment', async () => {
  const ctx = await setupTest();
  const store = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => store.stop());

  await store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'),
      cwd: ctx.directory,
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
    ATC_OUTBOX: join(ctx.directory, 'g', 'run', '0f1e2d3c4b5a6978.outbox'),
    ATC_SESSION_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    ATC_SESSION_RECORD: join(
      ctx.directory,
      'g',
      'records',
      '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.json',
    ),
    ATC_SOCKET: join(ctx.directory, 'g', 'run', '0f1e2d3c4b5a6978.sock'),
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a slept session inside the same process by waking its imp', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const output = ctx.events
      .filter((event) => event.ev === 'SessionOutput')
      .map((event) => event.data)
      .join('');

    const match = /UP:(?<pid>\d+)/u.exec(output);

    invariant(match?.groups?.['pid'] !== undefined, 'the harness has not started');

    return match.groups['pid'];
  });

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.input', { session: id, data: 'again\r' });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event.data)
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
  const probe = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.input', { session: id, data: 'quit\r' });

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
    cwd: ctx.directory,
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

test('it keeps a delivered message delivered when the connection to its imp session is lost for good', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  ctx.port.setSessionDrops(10, 1011);
  ctx.port.stopConnection(String(imp), request.session, 1011);

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  const read = await ctx.client.sendRequest('message.get', { message: sent['message'] });

  expect(read['status']).toBe('delivered');
});

test('it marks a message unanswered when its tap acks it after the imp process exited', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });
  await ctx.client.sendRequest('session.input', { session: id, data: 'quit\r' });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false, lastMsg: 'process exited' });
  });

  const acked = await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'unanswered' });
});

test('it keeps a message delivered when its tap acks it after the connection to its imp session is lost for good', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });

  ctx.port.setSessionDrops(10, 1011);
  ctx.port.stopConnection(String(imp), request.session, 1011);

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  const acked = await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'delivered' });
});

test('it keeps an imp session message delivered across a daemon restart beside a local session of the same agent session, then answers it', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    target: 'local',
  });

  const remote = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const remoteID = getRecord(remote, 'session')['id'];

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: remoteID, text: 'hi' });

  await tap.sendRequest('session.tap', { session: remoteID });
  await tap.sendRequest('message.ack', { session: remoteID, message: sent['message'] });
  await ctx.restart();

  const client = await ctx.openClient();
  const afterRestart = await client.sendRequest('message.get', { message: sent['message'] });

  await ctx.sendHookLines({
    atcId: remoteID,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const read = await client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');
  });

  expect(afterRestart['status']).toBe('delivered');
});

test('it keeps an imp session message delivered across a daemon restart after a local spawn resumes its agent session, then answers it', async () => {
  const ctx = await setupTest();

  const remote = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const remoteID = getRecord(remote, 'session')['id'];

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    target: 'local',
  });

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: remoteID, text: 'hi' });

  await tap.sendRequest('session.tap', { session: remoteID });
  await tap.sendRequest('message.ack', { session: remoteID, message: sent['message'] });
  await ctx.restart();

  const client = await ctx.openClient();
  const afterRestart = await client.sendRequest('message.get', { message: sent['message'] });

  await ctx.sendHookLines({
    atcId: remoteID,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const read = await client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');
  });

  expect(afterRestart['status']).toBe('delivered');
});

test('it marks a local session message unanswered across a daemon restart after an imp spawn resumes its agent session', async () => {
  const ctx = await setupTest();

  const local = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    target: 'local',
  });

  const localID = getRecord(local, 'session')['id'];

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const tap = await ctx.openClient();
  const sent = await ctx.client.sendRequest('session.message', { session: localID, text: 'hi' });

  await tap.sendRequest('session.tap', { session: localID });
  await tap.sendRequest('message.ack', { session: localID, message: sent['message'] });
  await ctx.restart();

  const client = await ctx.openClient();
  const afterRestart = await client.sendRequest('message.get', { message: sent['message'] });

  expect(afterRestart['status']).toBe('unanswered');
});

test('it restores an imp session after a daemon restart when a local spawn resumed its agent session first', async () => {
  const ctx = await setupTest();

  const remote = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const remoteID = getRecord(remote, 'session')['id'];

  await ctx.restart();

  const client = await ctx.openClient();

  await client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    target: 'local',
  });

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: remoteID, alive: true, kind: 'pty' });
  });
});

test('it lists a session whose imp another owner put to sleep as asleep', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
        .map((event) => event.data)
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

test('it restores a session whose imp another owner put to sleep as suspended after a daemon restart', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
        .map((event) => event.data)
        .join(''),
    ).toInclude('UP:');
  });

  ctx.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, lastMsg: 'asleep' }] });
  });

  await ctx.restart();

  const client = await ctx.openClient();

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      {
        id,
        state: 'exited',
        lastMsg: 'asleep',
        lifecycle: { desired: 'run', vm: 'asleep', harness: 'suspended', attachment: 'detached' },
      },
    ],
  });
});

test('it revives a session whose imp another owner put to sleep in the same process', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const match = /UP:(?<pid>\d+)/u.exec(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event.data)
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
  await ctx.client.sendRequest('session.input', { session: id, data: 'again\r' });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event.data)
        .join(''),
    ).toInclude(`GOT:again:${pid}`);
  });
});

test('it gives its lease back when a session it revived from sleep exits', async () => {
  const ctx = await setupTest();
  const probe = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const [imp] = ctx.port.collectImpNames();

  await ctx.client.sendRequest('session.input', { session: id, data: 'quit\r' });

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
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-parent',
  });

  const parentID = getRecord(parent, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    resume: 'agent-child',
    parent: parentID,
  });

  const childID = getRecord(child, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: parentID });

  ctx.port.setAcquireFailure(1, 'SERVICE_UNAVAILABLE');

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
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(ctx.directory, 'g', 'records', `${id}.json`);
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
      workspace: { path: ctx.directory, branch: null, repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it places the copy among the imp’s read-only files when the imp’s agent keeps them', async () => {
  const ctx = await setupTest();

  ctx.port.readOnlyFilesDir = join(ctx.directory, 'ro');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const name = getOnlyImpName(ctx.port);
  const path = join(ctx.directory, 'ro', name, 'atc', 'records', `${id}.json`);
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  const copy = await readJSONRecord(Bun.file(path));

  expect(request.env['ATC_SESSION_RECORD']).toBe(path);
  expect(copy).toMatchObject({ format: 'atc.session-record', session: id, revision: 1 });
  expect(ctx.port.calls).toContain(`files.write ${name} atc/records/${id}.json`);
  expect(existsSync(join(ctx.directory, 'g', 'records', `${id}.json`))).toBeFalse();
});

test('it replaces the read-only copy when a caller adds to the scope', async () => {
  const ctx = await setupTest();
  const fixture = await createGitFixture({ prefix: 'atc-daemon-imp-record-' });

  ctx.port.readOnlyFilesDir = join(ctx.directory, 'ro');

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
  const path = join(ctx.directory, 'ro', getOnlyImpName(ctx.port), 'atc', 'records', `${id}.json`);

  const copy = await readJSONRecord(Bun.file(path));

  expect(record['revision']).toBe(2);
  expect(copy).toStrictEqual(record);
});

test('it keeps the guest-folder copy current for a harness restored after the imp’s agent gained read-only files', async () => {
  const ctx = await setupTest();
  const fixture = await createGitFixture({ prefix: 'atc-daemon-imp-record-' });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: fixture.work,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  ctx.port.readOnlyFilesDir = join(ctx.directory, 'ro');

  await ctx.restart();

  const client = await ctx.openClient();

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: true, kind: 'pty' });
  });

  const added = await client.sendRequest('session.scope.add', {
    session: id,
    scope: { branches: [{ name: 'main' }] },
  });

  const record = getRecord(added, 'record');
  const guestPath = join(ctx.directory, 'g', 'records', `${id}.json`);

  const protectedPath = join(
    ctx.directory,
    'ro',
    getOnlyImpName(ctx.port),
    'atc',
    'records',
    `${id}.json`,
  );

  const guestCopy = await readJSONRecord(Bun.file(guestPath));
  const protectedCopy = await readJSONRecord(Bun.file(protectedPath));

  expect(record['revision']).toBe(2);
  expect(guestCopy).toStrictEqual(record);
  expect(statSync(guestPath).mode & 0o777).toBe(0o444);
  expect(protectedCopy).toStrictEqual(record);
});

test('it places the copy in the guest folder when the imp’s agent is from before read-only files', async () => {
  const ctx = await setupTest();

  // the port holds no folder for read-only files, as an imp still on an
  // older agent

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(ctx.directory, 'g', 'records', `${id}.json`);
  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'the spawn sent no start request');

  expect(request.env['ATC_SESSION_RECORD']).toBe(path);
  expect(statSync(path).mode & 0o777).toBe(0o444);
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
  const path = join(ctx.directory, 'g', 'records', `${id}.json`);

  expect(record['revision']).toBe(2);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual(record);
  expect(statSync(path).mode & 0o777).toBe(0o444);
});
