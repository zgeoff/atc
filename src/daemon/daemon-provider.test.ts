import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

test('it streams the output of a session harness on the local pty provider', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      // The agent prints a marker, then echoes each line it reads.
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'bash',
          args: ['-c', 'echo FAKE_CLAUDE_UP; while read -r line; do echo "GOT:$line"; done'],
        }),
      }),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  await daemon.client.sendRequest('session.attach', {
    session: getRecord(spawned, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event['d'])
        .join(''),
    ).toInclude('FAKE_CLAUDE_UP');
  });
});

test('it types input into a session harness on the local pty provider', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      // The agent prints a marker, then echoes each line it reads.
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'bash',
          args: ['-c', 'echo FAKE_CLAUDE_UP; while read -r line; do echo "GOT:$line"; done'],
        }),
      }),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.input', { session: id, d: 'ping\r' });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event['d'])
        .join(''),
    ).toInclude('GOT:ping');
  });
});

test('it kills a session harness on the local pty provider', async () => {
  const provider = new LocalPTYProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id, state: 'exited', alive: false })],
  });
});

test('it refuses a spawn with unsupported_operation when the provider cannot spawn', async () => {
  const provider = buildStubExecutionProvider({ kind: 'no-spawn', capabilities: { spawn: false } });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  await Promise.allSettled([spawned]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({ code: 'unsupported_operation' });
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses input with unsupported_operation when the provider takes no input', async () => {
  const provider = buildStubExecutionProvider({ kind: 'no-input', capabilities: { input: false } });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const input = daemon.client.sendRequest('session.input', {
    session: getRecord(spawned, 'session')['id'],
    d: 'ping\r',
  });

  expect(input).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it refuses a kill with unsupported_operation when the provider cannot end a harness', async () => {
  const provider = buildStubExecutionProvider({ kind: 'no-kill', capabilities: { kill: false } });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const killed = daemon.client.sendRequest('session.kill', { session: id });

  await Promise.allSettled([killed]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(killed).rejects.toMatchObject({ code: 'unsupported_operation' });
  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: true })] });
});

test('it refuses an attach with unsupported_operation when the provider streams no output', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'no-attach',
    capabilities: { attach: false },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const attach = daemon.client.sendRequest('session.attach', {
    session: getRecord(spawned, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  expect(attach).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it takes a resize from an attached client on a provider that cannot resize', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'no-resize',
    capabilities: { resize: false },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const resized = await daemon.client.sendRequest('session.resize', {
    session: id,
    cols: 120,
    rows: 40,
  });

  expect(resized).toStrictEqual({});

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionResized', cols: 120, rows: 40 });
  });
});

test('it puts the host of a killed session to sleep on a provider that can suspend it', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'sleepy',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const listed = await daemon.client.sendRequest('session.list');

  expect<readonly unknown[]>(provider.suspended).toStrictEqual([id]);

  expect(listed).toStrictEqual({
    sessions: [
      expect.objectContaining({
        id,
        state: 'exited',
        lastMsg: 'asleep',
        alive: false,
        lifecycle: { desired: 'sleep', vm: 'asleep', harness: 'suspended', attachment: 'detached' },
      }),
    ],
  });
});

test('it refuses a second kill with confirmation_required on a provider that can destroy the host', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'sleepy',
    capabilities: { suspend: true, destroy: true },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const killedAgain = daemon.client.sendRequest('session.kill', { session: id });

  await Promise.allSettled([killedAgain]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(killedAgain).rejects.toMatchObject({
    code: 'confirmation_required',
    data: { session: id },
  });

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id, lastMsg: 'asleep' })],
  });
});

test('it keeps a session running when its host refuses to sleep', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'sleepy',
    capabilities: { suspend: true, destroy: true },
  });

  provider.setSuspendFailure(
    new DaemonError('host_leased', 'another owner keeps the host awake', {
      leases: [],
      otherCount: 1,
    }),
  );

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const killed = daemon.client.sendRequest('session.kill', { session: id });

  await Promise.allSettled([killed]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(killed).rejects.toMatchObject({
    code: 'host_leased',
    data: { leases: [], otherCount: 1 },
  });

  expect(listed).toStrictEqual({
    sessions: [
      expect.objectContaining({
        id,
        state: 'running',
        alive: true,
        lifecycle: { desired: 'run', vm: 'awake', harness: 'running', attachment: 'attached' },
      }),
    ],
  });
});
