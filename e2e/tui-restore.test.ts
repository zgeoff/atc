import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { spawnGrokSession } from '../src/test-utils/spawn-grok-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

function setupTest() {
  return startTUIHarness();
}

test('it restores the fleet from disk after a crash', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'fleettest');

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    using db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

    expect(
      db.query('SELECT name, cwd, agent_session_id AS agentSessionID FROM fleet').all(),
    ).toStrictEqual([{ name: 'fleettest', cwd: ctx.home, agentSessionID: 'fake-1' }]);
  });

  // A full crash: client and daemon both die, and the fleet row survives
  // on disk.
  const daemonPID = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

  pty.kill();
  process.kill(daemonPID, 'SIGKILL');

  await ctx.waitForExit();

  await waitFor(() => {
    expect(() => process.kill(daemonPID, 0)).toThrow();
  });

  ctx.reset();
  ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});

test('it restores a grok session with grok --resume after a crash', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokfleet');

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    using db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

    expect(
      db.query('SELECT name, cwd, agent_session_id AS agentSessionID, agent FROM fleet').all(),
    ).toStrictEqual([
      { name: 'grokfleet', cwd: ctx.home, agentSessionID: 'fake-grok-1', agent: 'grok' },
    ]);
  });

  const daemonPID = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

  pty.kill();
  process.kill(daemonPID, 'SIGKILL');

  await ctx.waitForExit();

  await waitFor(() => {
    expect(() => process.kill(daemonPID, 0)).toThrow();
  });

  ctx.reset();
  ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_GROK_UP');
  await ctx.waitFor('--resume fake-grok-1');

  expect(ctx.read()).not.toInclude('claude --resume');
  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);
