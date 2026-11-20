import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLocalTarget } from '@atc/app/test-utils/build-local-target';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { startDaemon } from '@atc/daemon';
import { startStubLegacyDaemonProcess } from '@atc/lifecycle/test-utils/start-stub-legacy-daemon-process';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/test-utils/build-mock-fleet-entry';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { toAgentSessionID } from '@atcx/contract';
import { createHostServices } from '../packages/app/src/daemon/create-host-services';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it restarts a daemon on another protocol after the user confirms and restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = ctx.paths.stateDir;
  const socketPath = ctx.paths.daemonSocketPath;

  mkdirSync(stateDir, { recursive: true });

  const seed = await createStateStore(ctx.paths.dbFile);

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'fleettest',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-1'),
    }),
  ]);

  await seed.stop();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        '..',
        'packages',
        'lifecycle',
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

test('it stops a daemon on another protocol after the user confirms, and the managed daemon after it restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = ctx.paths.stateDir;
  const socketPath = ctx.paths.daemonSocketPath;
  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  // An installed unit makes the client wait for the unit's daemon instead
  // of starting one.
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const seed = await createStateStore(ctx.paths.dbFile);

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'unitfleet',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-unit-1'),
    }),
  ]);

  await seed.stop();

  const legacy = await startStubLegacyDaemonProcess(socketPath, stateDir);

  ctx.boot();

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);

  ctx.reset();
  ctx.write('y');

  await legacy.exited;

  // The unit's manager starts the new daemon once the old one stops.
  const next = await startDaemon({
    restoreFleetOnRestart: true,
    socketPath,
    reporterSocketPath: ctx.paths.socketPath,
    dbPath: ctx.paths.dbFile,
    statusPath: ctx.paths.statusFile,
    build: createHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => next.stop());

  await ctx.waitFor('1 running');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('unitfleet');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it stops a daemon of an older build when the user asks for the update and boots its own build', async () => {
  const ctx = setupTest();
  const stateDir = ctx.paths.stateDir;
  const socketPath = ctx.paths.daemonSocketPath;

  mkdirSync(stateDir, { recursive: true });

  // It answers no quit request, so only a stop from outside ends it.
  const older = Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        '..',
        'packages',
        'lifecycle',
        'src',
        'test-utils',
        'run-stub-legacy-daemon.ts',
      ),
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

  expect(ctx.read()).not.toInclude('Restart it now?');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('u update daemon');

  ctx.reset();
  ctx.write('u');

  await ctx.waitFor('restarting daemon');

  await older.exited;

  await ctx.waitFor('idle');

  // The status bar is drawn on a timer, so one the menu scheduled can still
  // draw the stale mark after the reset; only what follows the restart's
  // own status bar counts.
  const screen = ctx.read();

  expect(older.signalCode).toBe('SIGTERM');
  expect(screen.slice(screen.lastIndexOf('restarting daemon'))).not.toInclude('update ready');
});
