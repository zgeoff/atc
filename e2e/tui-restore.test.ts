import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import {
  registerTestCleanup,
  resolveATCCommand,
  spawnNamedSession,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';

function setupTest() {
  return startTUIHarness();
}

test('it restores the fleet from disk after a crash', async () => {
  const ctx = setupTest();

  // The daemon that crashes runs with the client's environment, and no
  // client is attached to it.
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.home, env: ctx.env });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  await spawnNamedSession(
    (method, params) => client.sendRequest(method, params),
    'fleettest',
    ctx.home,
  );

  const db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    expect(
      db.query('SELECT name, cwd, agent_session_id AS agentSessionID FROM fleet').all(),
    ).toStrictEqual([{ name: 'fleettest', cwd: ctx.home, agentSessionID: 'fake-1' }]);
  });

  // A crash: the daemon dies, and the fleet row survives on disk.
  daemon.subprocess.kill('SIGKILL');

  await daemon.subprocess.exited;

  ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});

test('it restores a grok session with grok --resume after a crash', async () => {
  const ctx = setupTest();

  // The daemon that crashes runs with the client's environment, and no
  // client is attached to it.
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.home, env: ctx.env });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'grokfleet',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    expect(
      db.query('SELECT name, cwd, agent_session_id AS agentSessionID, agent FROM fleet').all(),
    ).toStrictEqual([
      { name: 'grokfleet', cwd: ctx.home, agentSessionID: 'fake-grok-1', agent: 'grok' },
    ]);
  });

  daemon.subprocess.kill('SIGKILL');

  await daemon.subprocess.exited;

  ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_GROK_UP');
  await ctx.waitFor('--resume fake-grok-1');

  expect(ctx.read()).not.toInclude('claude --resume');
  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);
