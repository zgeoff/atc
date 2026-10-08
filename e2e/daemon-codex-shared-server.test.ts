import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRecord } from '../src/shared/get-record';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubSharedServerCodex } from '../src/test-utils/create-stub-shared-server-codex';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with a stub Codex CLI whose terminals share one background server,
 * offered as the only agent and served by an `atc daemon` process, with a
 * client that has sent its handshake. The daemon leaves the stored fleet
 * alone at start, so a test restores it itself.
 */
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const home = mkdtempSync(join(tmpdir(), 'atc-e2e-codex-shared-'));

  stack.defer(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const atc = resolveATCCommand();
  const composer = createStubComposer(home);

  // The daemon spawns its sessions from the agents the config offers, and a
  // restarted daemon restores only when a test asks it to.
  mkdirSync(join(home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: { codex: { bin: createStubSharedServerCodex(home, { atc, composer }) } },
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = stack.use(startDaemonProcess({ command: atc, home }));

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  return { home, daemon, client };
}

test('it keeps the hook events of two codex terminals that share a server on their own sessions', async () => {
  const ctx = await setupTest();

  const firstSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const trail = new Database(join(ctx.daemon.stateDir, 'atc.db'), { readonly: true });

  onTestFinished(() => {
    trail.close();
  });

  const rows = await waitFor(() => {
    const read = trail.query('SELECT atc_id, event, session_id FROM events').all();

    expect(read).toHaveLength(4);

    return read;
  });

  const firstRecord = await ctx.client.sendRequest('session.get', { session: first });
  const secondRecord = await ctx.client.sendRequest('session.get', { session: second });

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
  const ctx = await setupTest();

  const firstSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    resume: 'thread-a',
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    resume: 'thread-b',
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const trail = new Database(join(ctx.daemon.stateDir, 'atc.db'), { readonly: true });

  onTestFinished(() => {
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
  const ctx = await setupTest();

  const firstSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const first = getString(getRecord(firstSpawned, 'session'), 'id');

  const secondSpawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const second = getString(getRecord(secondSpawned, 'session'), 'id');

  const trail = new Database(join(ctx.daemon.stateDir, 'atc.db'), { readonly: true });

  onTestFinished(() => {
    trail.close();
  });

  await waitFor(() => {
    expect(trail.query('SELECT id FROM events').all()).toHaveLength(4);
  });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

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
