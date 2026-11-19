import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubComposer } from '@atc/app/test-utils/create-stub-composer';
import { resolvePaths } from '@atc/config';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStubSharedServerCodex } from '@atc/harness-codex/test-utils/create-stub-shared-server-codex';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { createStateStore } from '@atc/store';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-codex-shared-');
  const atc = resolveATCCommand();
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    codex: createStubSharedServerCodex(temporaryDirectory.path, {
      atc,
      composer: createStubComposer(temporaryDirectory.path),
    }),
  };
}

test('it keeps the hook events of two codex terminals that share a server on their own sessions', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { codex: { bin: ctx.codex } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const firstSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const store = await createStateStore(resolvePaths({ HOME: ctx.home }).dbFile);

  registerTestCleanup(() => store.stop());

  const rows = await waitFor(async () => {
    const read = await store.readTrailRows();

    expect(read).toHaveLength(4);

    return read.map((row) => ({
      atcID: row.atcID,
      event: row.event,
      agentSessionID: row.agentSessionID,
    }));
  });

  const firstRecord = await client.sendRequest('session.get', { session: first });
  const secondRecord = await client.sendRequest('session.get', { session: second });

  expect(rows).toIncludeSameMembers([
    { atcID: first, event: 'SessionStart', agentSessionID: `fake-thread-${first}` },
    { atcID: first, event: 'Stop', agentSessionID: `fake-thread-${first}` },
    { atcID: second, event: 'SessionStart', agentSessionID: `fake-thread-${second}` },
    { atcID: second, event: 'Stop', agentSessionID: `fake-thread-${second}` },
  ]);

  expect(firstRecord).toMatchObject({
    session: { agentSessionID: `fake-thread-${first}` },
    result: `done fake-thread-${first}`,
  });

  expect(secondRecord).toMatchObject({
    session: { agentSessionID: `fake-thread-${second}` },
    result: `done fake-thread-${second}`,
  });
});

test('it keeps two resumed codex terminals that share a server on the threads they resumed', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { codex: { bin: ctx.codex } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const firstSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    resume: 'thread-a',
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    resume: 'thread-b',
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const store = await createStateStore(resolvePaths({ HOME: ctx.home }).dbFile);

  registerTestCleanup(() => store.stop());

  const rows = await waitFor(async () => {
    const read = await store.readTrailRows();

    expect(read).toHaveLength(4);

    return read.map((row) => ({
      atcID: row.atcID,
      event: row.event,
      agentSessionID: row.agentSessionID,
    }));
  });

  expect(rows).toIncludeSameMembers([
    { atcID: first, event: 'SessionStart', agentSessionID: 'thread-a' },
    { atcID: first, event: 'Stop', agentSessionID: 'thread-a' },
    { atcID: second, event: 'SessionStart', agentSessionID: 'thread-b' },
    { atcID: second, event: 'Stop', agentSessionID: 'thread-b' },
  ]);
});

test('it keeps two restored codex terminals that share a server on their own threads', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { codex: { bin: ctx.codex } },

      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const firstSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const store = await createStateStore(resolvePaths({ HOME: ctx.home }).dbFile);

  registerTestCleanup(() => store.stop());

  await waitFor(async () => {
    const read = await store.readTrailRows();

    expect(read).toHaveLength(4);
  });

  await daemon.restart('SIGKILL');

  const revived = await daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const rows = await waitFor(async () => {
    const read = await store.readTrailRows();

    const restored = read.filter((row) => row.id > 4);

    expect(restored).toHaveLength(4);

    return restored.map((row) => ({
      atcID: row.atcID,
      event: row.event,
      agentSessionID: row.agentSessionID,
    }));
  });

  expect(rows).toIncludeSameMembers([
    { atcID: first, event: 'SessionStart', agentSessionID: `fake-thread-${first}` },
    { atcID: first, event: 'Stop', agentSessionID: `fake-thread-${first}` },
    { atcID: second, event: 'SessionStart', agentSessionID: `fake-thread-${second}` },
    { atcID: second, event: 'Stop', agentSessionID: `fake-thread-${second}` },
  ]);
});
