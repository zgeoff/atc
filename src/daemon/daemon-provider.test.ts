import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

interface SetupConfig {
  // The provider the daemon's one target runs its sessions on.
  readonly provider: ExecutionProvider;
}

// A real daemon whose one target runs on the provider the config wires, with
// an agent that prints a marker, then echoes each line it reads.
function setupTest(config: SetupConfig) {
  return startTestDaemon({
    prefix: 'atc-daemon-provider-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'bash',
          args: ['-c', 'echo FAKE_CLAUDE_UP; while read -r line; do echo "GOT:$line"; done'],
        }),
      }),
      targets: [
        {
          id: 'local',
          kind: config.provider.kind,
          options: {},
          identity: 'test:local',
          provider: config.provider,
        },
      ],
    }),
  });
}

test('it streams the output of a session harness on the local pty provider', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.attach', {
    session: getRecord(spawned, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event['d'])
        .join(''),
    ).toInclude('FAKE_CLAUDE_UP');
  });
});

test('it types input into a session harness on the local pty provider', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.input', { session: id, d: 'ping\r' });

  await waitFor(() => {
    expect(
      ctx.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event['d'])
        .join(''),
    ).toInclude('GOT:ping');
  });
});

test('it kills a session harness on the local pty provider', async () => {
  await using ctx = await setupTest({ provider: new LocalPTYProvider() });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.objectContaining({ id, state: 'exited', alive: false })],
  });
});

test('it refuses a spawn with unsupported_operation when the provider cannot spawn', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({ kind: 'no-spawn', capabilities: { spawn: false } }),
  });

  const spawned = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  expect(spawned).rejects.toMatchObject({ code: 'unsupported_operation' });
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses input with unsupported_operation when the provider takes no input', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({ kind: 'no-input', capabilities: { input: false } }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const input = ctx.client.sendRequest('session.input', {
    session: getRecord(spawned, 'session')['id'],
    d: 'ping\r',
  });

  expect(input).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it refuses a kill with unsupported_operation when the provider cannot end a harness', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({ kind: 'no-kill', capabilities: { kill: false } }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const killed = ctx.client.sendRequest('session.kill', { session: id });

  expect(killed).rejects.toMatchObject({ code: 'unsupported_operation' });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses an attach with unsupported_operation when the provider streams no output', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({ kind: 'no-attach', capabilities: { attach: false } }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const attach = ctx.client.sendRequest('session.attach', {
    session: getRecord(spawned, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  expect(attach).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it takes a resize from an attached client on a provider that cannot resize', async () => {
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({ kind: 'no-resize', capabilities: { resize: false } }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const resized = await ctx.client.sendRequest('session.resize', {
    session: id,
    cols: 120,
    rows: 40,
  });

  expect(resized).toStrictEqual({});

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionResized', cols: 120, rows: 40 });
  });
});

test('it puts the host of a killed session to sleep on a provider that can suspend it', async () => {
  const provider = buildStubExecutionProvider({
    kind: 'sleepy',
    capabilities: { suspend: true, destroy: true },
  });

  await using ctx = await setupTest({ provider });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  expect<readonly unknown[]>(provider.suspended).toStrictEqual([id]);

  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({
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
  await using ctx = await setupTest({
    provider: buildStubExecutionProvider({
      kind: 'sleepy',
      capabilities: { suspend: true, destroy: true },
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const killedAgain = ctx.client.sendRequest('session.kill', { session: id });

  expect(killedAgain).rejects.toMatchObject({
    code: 'confirmation_required',
    data: { session: id },
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
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

  await using ctx = await setupTest({ provider });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const killed = ctx.client.sendRequest('session.kill', { session: id });

  expect(killed).rejects.toMatchObject({
    code: 'host_leased',
    data: { leases: [], otherCount: 1 },
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toMatchObject({
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
