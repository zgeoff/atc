import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { startTUIHarness } from '@atc/test-utils/start-tui-harness';
import { PROTOCOL_V } from '../packages/app/src/protocol/protocol';
import { toAgentSessionID } from '../packages/app/src/shared/to-agent-session-id';
import { StateStore } from '../packages/app/src/store/state-store';
import { buildMockFleetEntry } from '../packages/app/src/test-utils/build-mock-fleet-entry';

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
      join(
        import.meta.dir,
        '..',
        'packages',
        'app',
        'src',
        'test-utils',
        'run-stub-legacy-daemon.ts',
      ),
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
