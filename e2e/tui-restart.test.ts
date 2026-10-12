import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { StateStore } from '@atc/store/state-store';
import { buildMockFleetEntry } from '@atc/store/testing/build-mock-fleet-entry';
import { KEYS } from '@atc/test-utils/keys';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { startTUIHarness } from '@atc/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it restarts a daemon on another protocol after the user confirms and restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');

  // The fleet a daemon that already ran here left behind: one resumable
  // Claude session in the home.
  mkdirSync(stateDir, { recursive: true });

  const seed = await StateStore.open(join(stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'fleettest',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-1'),
    }),
  ]);

  await seed.stop();

  // A daemon on another protocol takes the socket and records its pid, as
  // a daemon from another release would.
  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
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

test('it stops a daemon of an older build when the user asks for the update and boots its own build', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');

  mkdirSync(stateDir, { recursive: true });

  // A daemon of an older build on this protocol takes the socket and
  // records its pid. It answers no quit request, so only a stop from
  // outside ends it.
  const older = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
      'current',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    older.kill('SIGKILL');
  });

  const reader = older.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  ctx.boot();

  await ctx.waitFor('update ready');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('u update daemon');

  ctx.reset();
  ctx.write('u');

  await older.exited;

  await ctx.waitFor('idle');

  expect(older.signalCode).toBe('SIGTERM');
  expect(ctx.read()).not.toInclude('update ready');
});
