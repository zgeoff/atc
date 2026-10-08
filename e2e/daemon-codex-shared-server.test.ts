import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '../src/shared/get-record';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubSharedServerCodex } from '../src/test-utils/create-stub-shared-server-codex';
import { getString } from '../src/test-utils/get-string';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with a stub Codex CLI whose terminals share one background server,
 * and the config path the test writes before it starts the `atc daemon`.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-codex-shared-');
  const atc = resolveATCCommand();
  const configDir = join(tmp.dir, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: tmp.dir,
    atc,
    configPath: join(configDir, 'config.json'),
    codex: createStubSharedServerCodex(tmp.dir, { atc, composer: createStubComposer(tmp.dir) }),
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

  const trail = new Database(join(daemon.stateDir, 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    trail.close();
  });

  const rows = await waitFor(() => {
    const read = trail.query('SELECT atc_id, event, session_id FROM events').all();

    expect(read).toHaveLength(4);

    return read;
  });

  const firstRecord = await client.sendRequest('session.get', { session: first });
  const secondRecord = await client.sendRequest('session.get', { session: second });

  expect(rows).toIncludeSameMembers([
    { atc_id: first, event: 'SessionStart', session_id: `fake-thread-${first}` },
    { atc_id: first, event: 'Stop', session_id: `fake-thread-${first}` },
    { atc_id: second, event: 'SessionStart', session_id: `fake-thread-${second}` },
    { atc_id: second, event: 'Stop', session_id: `fake-thread-${second}` },
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

  const trail = new Database(join(daemon.stateDir, 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    trail.close();
  });

  const rows = await waitFor(() => {
    const read = trail.query('SELECT atc_id, event, session_id FROM events').all();

    expect(read).toHaveLength(4);

    return read;
  });

  expect(rows).toIncludeSameMembers([
    { atc_id: first, event: 'SessionStart', session_id: 'thread-a' },
    { atc_id: first, event: 'Stop', session_id: 'thread-a' },
    { atc_id: second, event: 'SessionStart', session_id: 'thread-b' },
    { atc_id: second, event: 'Stop', session_id: 'thread-b' },
  ]);
});

test('it keeps two restored codex terminals that share a server on their own threads', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { codex: { bin: ctx.codex } },

      // A restarted daemon restores only when the test asks it to.
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

  const trail = new Database(join(daemon.stateDir, 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    trail.close();
  });

  await waitFor(() => {
    expect(trail.query('SELECT id FROM events').all()).toHaveLength(4);
  });

  await daemon.restart('SIGKILL');

  const revived = await daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const rows = await waitFor(() => {
    const read = trail.query('SELECT atc_id, event, session_id FROM events WHERE id > 4').all();

    expect(read).toHaveLength(4);

    return read;
  });

  expect(rows).toIncludeSameMembers([
    { atc_id: first, event: 'SessionStart', session_id: `fake-thread-${first}` },
    { atc_id: first, event: 'Stop', session_id: `fake-thread-${first}` },
    { atc_id: second, event: 'SessionStart', session_id: `fake-thread-${second}` },
    { atc_id: second, event: 'Stop', session_id: `fake-thread-${second}` },
  ]);
});
