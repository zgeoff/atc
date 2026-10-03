import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

// A real daemon whose sessions run on the execution provider the test hands
// it, with a fake claude that echoes each line it reads.
async function setupTest(provider: ExecutionProvider) {
  const tmp = setupTempDir('atc-daemon-provider-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP"
while read -r line; do echo "GOT:$line"; done
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
    provider,
  });

  const client = await DaemonClient.open(sockPath);

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test-build');

  return {
    client,
    dir: tmp.dir,
    events,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it streams a session harness on the local pty provider and types into it', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => event['d'])
        .join(''),
    ).toInclude('FAKE_CLAUDE_UP');
  });

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
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toStrictEqual([
    expect.objectContaining({ id, state: 'exited', alive: false }),
  ]);
});

test('it refuses a spawn with unsupported_operation when the provider cannot spawn', async () => {
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'no-spawn',
    capabilities: { ...local.capabilities, spawn: false },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({ code: 'unsupported_operation' });

  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [],
  });
});

test('it refuses input with unsupported_operation when the provider takes no input', async () => {
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'no-input',
    capabilities: { ...local.capabilities, input: false },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
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
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'no-kill',
    capabilities: { ...local.capabilities, kill: false },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  expect(daemon.client.sendRequest('session.kill', { session: id })).rejects.toMatchObject({
    code: 'unsupported_operation',
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses an attach with unsupported_operation when the provider streams no output', async () => {
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'no-attach',
    capabilities: { ...local.capabilities, attach: false },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
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
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'no-resize',
    capabilities: { ...local.capabilities, resize: false },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
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
