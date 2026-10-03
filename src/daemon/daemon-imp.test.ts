import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';

// A real daemon whose one target `box` runs on the imp provider over a
// fixture imp port, with a fake claude that prints its pid and echoes each
// line it reads.
async function setupTest() {
  const tmp = setupTempDir('atc-daemon-imp-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');

  const port = new FixtureImpPort();

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line:$$"
done
`,
    { mode: 0o755 },
  );

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [
      {
        id: 'box',
        kind: 'imp',
        options: {},
        identity: 'imp:test',
        provider: new ImpProvider(port, {}, { reconnectDelaysMs: [0, 0, 0] }),
      },
    ],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(sockPath);

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  const hello = await client.sendHello('atc/test-build');

  return {
    client,
    port,
    events,
    dir: tmp.dir,
    daemonID: hello['daemonID'],
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it starts each top-level session in an imp of its own', async () => {
  await using daemon = await setupTest();

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 80, rows: 24 });

  expect(daemon.port.collectImpNames()).toHaveLength(2);
});

test("it runs a sub-session in its parent's imp", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(daemon.port.collectImpNames()).toHaveLength(1);

  const [imp] = daemon.port.collectImpNames();

  expect<readonly unknown[]>(
    daemon.port.sessionRequests.map((request) => request.name),
  ).toStrictEqual([imp, imp]);
});

test('it releases its own lease before it puts the imp of a killed session to sleep', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();

  await daemon.client.sendRequest('session.kill', { session: id });

  expect(
    daemon.port.calls.filter((call) => call.startsWith('leases.') || call.startsWith('imps.sleep')),
  ).toStrictEqual([
    `leases.acquire ${imp} atc-${String(daemon.daemonID)}`,
    `leases.release ${imp} atc-${String(daemon.daemonID)}`,
    `imps.sleep ${imp}`,
  ]);

  expect(daemon.port.findState(String(imp))).toBe('sleeping');

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
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
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();

  daemon.port.acquireOtherLease(String(imp), 'token:other', 'build', 60);

  const killed = daemon.client.sendRequest('session.kill', { session: id });

  expect(killed).rejects.toMatchObject({
    code: 'host_leased',
    data: { leases: [], otherCount: 1 },
  });

  await killed.catch(() => null);

  expect(daemon.port.calls.filter((call) => call.startsWith('leases.'))).toStrictEqual([
    `leases.acquire ${imp} atc-${String(daemon.daemonID)}`,
    `leases.release ${imp} atc-${String(daemon.daemonID)}`,
    `leases.acquire ${imp} atc-${String(daemon.daemonID)}`,
  ]);

  expect(daemon.port.findState(String(imp))).toBe('running');

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, state: 'running', alive: true }],
  });
});

test('it destroys the imp of a session once a forget carries its confirm token', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  expect(daemon.port.collectImpNames()).toHaveLength(1);

  await daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(daemon.port.collectImpNames()).toBeEmpty();
});

test('it starts a remote harness with only the variables atc sets, never the daemon environment', async () => {
  await using daemon = await setupTest();

  const previousCanary = process.env['ATC_TEST_DAEMON_CANARY'];
  const previousCredential = process.env['ATC_TEST_WORKSPACE_TOKEN'];

  process.env['ATC_TEST_DAEMON_CANARY'] = 'daemon-only';
  process.env['ATC_TEST_WORKSPACE_TOKEN'] = 'fixture-not-a-secret';

  onTestFinished(() => {
    if (previousCanary === undefined) {
      delete process.env['ATC_TEST_DAEMON_CANARY'];
    } else {
      process.env['ATC_TEST_DAEMON_CANARY'] = previousCanary;
    }

    if (previousCredential === undefined) {
      delete process.env['ATC_TEST_WORKSPACE_TOKEN'];
    } else {
      process.env['ATC_TEST_WORKSPACE_TOKEN'] = previousCredential;
    }
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const [request] = daemon.port.sessionRequests;

  if (request?.kind !== 'start') {
    throw new Error('the spawn sent no start request');
  }

  expect<Readonly<Record<string, unknown>>>(request.env).toStrictEqual({
    ATC_SESSION_ID: getRecord(spawned, 'session')['id'],
    LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm-256color',
  });
});

test('it revives a slept session inside the same process by waking its imp', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const output = daemon.events
      .filter((event) => event.ev === 'SessionOutput')
      .map((event) => String(event['d']))
      .join('');

    const match = /UP:(?<pid>\d+)/.exec(output);

    if (match?.groups?.['pid'] === undefined) {
      throw new Error('the harness has not started');
    }

    return match.groups['pid'];
  });

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.input', { session: id, d: 'again\r' });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude(`GOT:again:${pid}`);
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
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
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();

  await daemon.client.sendRequest('session.input', { session: id, d: 'quit\r' });

  await waitFor(() => {
    expect(daemon.port.calls).toContain(`leases.release ${imp} atc-${String(daemon.daemonID)}`);
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [
      {
        id,
        state: 'exited',
        lastMsg: 'process exited',
        lifecycle: { desired: 'run', vm: 'awake', harness: 'exited', attachment: 'detached' },
      },
    ],
  });

  expect(daemon.port.findState(String(imp))).toBe('running');
});

test('it lists a session as reattaching while its connection is lost and as attached once it resumes', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();
  const [request] = daemon.port.sessionRequests;

  await waitFor(() => {
    expect(daemon.port.getEnd(String(imp), String(request?.session))).toBeGreaterThan(0);
  });

  daemon.port.stopConnection(String(imp), String(request?.session), 1011);

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => getRecord(getRecord(event, 'session'), 'lifecycle')['attachment']),
    ).toStrictEqual(['reattaching', 'attached']);
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, state: 'running', alive: true }],
  });
});

test('it lists a session whose imp another owner put to sleep as asleep, and revives it in the same process', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const pid = await waitFor(() => {
    const match = /UP:(?<pid>\d+)/.exec(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    );

    if (match?.groups?.['pid'] === undefined) {
      throw new Error('the harness has not started');
    }

    return match.groups['pid'];
  });

  daemon.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

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

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.input', { session: id, d: 'again\r' });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude(`GOT:again:${pid}`);
  });
});

test('it gives its lease back when a session it revived from sleep exits', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();
  const release = `leases.release ${imp} atc-${String(daemon.daemonID)}`;

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.input', { session: id, d: 'quit\r' });

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call === release)).toHaveLength(2);
  });
});
