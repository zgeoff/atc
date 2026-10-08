import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '../src/protocol/protocol';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

function setupTest() {
  return startTUIHarness();
}

test('it restarts a daemon on another protocol after the user confirms and restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');
  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'fleettest');

  const db = new Database(join(stateDir, 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    expect(db.query('SELECT agent_session_id AS agentSessionID FROM fleet').all()).toStrictEqual([
      { agentSessionID: 'fake-1' },
    ]);
  });

  const daemonPID = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

  pty.kill();
  process.kill(daemonPID, 'SIGKILL');

  await ctx.waitForExit();

  await waitFor(() => {
    expect(() => process.kill(daemonPID, 0)).toThrow();
  });

  // A daemon on another protocol takes the socket and records its pid, as
  // a daemon from another release would.
  rmSync(socketPath, { force: true });

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'src', 'test-utils', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    legacy.kill('SIGKILL');
  });

  const reader = legacy.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  ctx.reset();
  ctx.boot();

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('fleettest');

  await legacy.exited;

  expect(legacy.signalCode).toBe('SIGTERM');
});
