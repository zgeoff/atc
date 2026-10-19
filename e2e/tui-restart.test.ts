import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentSessionID } from '@atc/core';
import { startDaemon } from '@atc/daemon';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  KEYS,
  buildMockAgentAdapter,
  registerTestCleanup,
  startStubLegacyDaemonProcess,
  startTUIHarness,
} from '@atc/test-utils';
import { buildHostServices } from '../packages/app/src/build-host-services';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';

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

test('it stops a daemon that speaks the line protocol after the user confirms, and the managed daemon after it restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');
  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  // An installed unit makes the client wait for the unit's daemon instead
  // of starting one.
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const seed = await StateStore.open(join(stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'linefleet',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-line-1'),
    }),
  ]);

  await seed.stop();

  const line = await startStubLegacyDaemonProcess(socketPath, stateDir, 'line');

  ctx.boot();

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude('the daemon speaks an older protocol');

  ctx.reset();
  ctx.write('y');

  await line.exited;

  // The unit's manager starts the new daemon once the old one stops, and
  // the new daemon restores the stored fleet.
  const next = await startDaemon({
    restoreFleetOnRestart: true,
    socketPath,
    reporterSocketPath: join(ctx.home, 'atc.sock'),
    dbPath: join(stateDir, 'atc.db'),
    statusPath: join(stateDir, 'status.json'),
    build: buildHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => next.stop());

  await ctx.waitFor('1 running');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('linefleet');

  expect(line.signalCode).toBe('SIGTERM');
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
