import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import {
  KEYS,
  buildMockAgentAdapter,
  registerTestCleanup,
  startStubLegacyDaemonProcess,
  startTUIHarness,
} from '@atc/test-utils';
import { buildHostServices } from '../packages/app/src/build-host-services';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';

// A client that waits for an installed unit's daemon after that daemon
// stopped, so a daemon on another protocol that takes the socket next is
// what its reconnect meets.
async function setupTest() {
  const harness = startTUIHarness();
  const stateDir = join(harness.home, '.local', 'state', 'atc');
  const socketPath = join(harness.home, 'atc-daemon.sock');
  const unitDir = join(harness.home, '.config', 'systemd', 'user');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const first = await startDaemon({
    socketPath,
    reporterSocketPath: join(harness.home, 'atc.sock'),
    dbPath: join(stateDir, 'atc.db'),
    statusPath: join(stateDir, 'status.json'),
    build: buildHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => first.stop());

  harness.boot();

  await harness.waitFor('no session');

  harness.reset();

  await first.stop();
  await harness.waitFor('waiting for daemon');

  return { harness, socketPath, stateDir };
}

test('it draws help again when the user confirms a restart that a reconnect meets with help open', async () => {
  const ctx = await setupTest();

  ctx.harness.write('?');

  await ctx.harness.waitFor('attach the selected session');

  const legacy = await startStubLegacyDaemonProcess(ctx.socketPath, ctx.stateDir);

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.reset();
  ctx.harness.write('y');

  await legacy.exited;

  await ctx.harness.waitFor('attach the selected session');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it draws the home screen again when the user confirms a restart that a reconnect meets at home', async () => {
  const ctx = await setupTest();

  ctx.harness.reset();
  ctx.harness.write(KEYS.esc);

  await ctx.harness.waitFor('control tower for coding-agent sessions');

  const legacy = await startStubLegacyDaemonProcess(ctx.socketPath, ctx.stateDir);

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.reset();
  ctx.harness.write('y');

  await legacy.exited;

  await ctx.harness.waitFor('control tower for coding-agent sessions');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it draws the spawn picker again when the user confirms a restart that a reconnect meets in the picker', async () => {
  const ctx = await setupTest();

  ctx.harness.reset();
  ctx.harness.write(KEYS.esc);

  await ctx.harness.waitFor('control tower for coding-agent sessions');

  ctx.harness.write('n');

  await ctx.harness.waitFor('spawn: agent');

  const legacy = await startStubLegacyDaemonProcess(ctx.socketPath, ctx.stateDir);

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.reset();
  ctx.harness.write('y');

  await legacy.exited;

  await ctx.harness.waitFor('spawn: agent');

  expect(legacy.signalCode).toBe('SIGTERM');
});
