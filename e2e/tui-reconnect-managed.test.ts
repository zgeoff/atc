import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLocalTarget } from '@atc/app/test-utils/build-local-target';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { startDaemon } from '@atc/daemon';
import { startStubLegacyDaemonProcess } from '@atc/lifecycle/test-utils/start-stub-legacy-daemon-process';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup } from '@zgeoff/testing';
import { createHostServices } from '../packages/app/src/daemon/create-host-services';

async function setupTest() {
  const harness = startTUIHarness({ createStateDB: createMigratedStateDB });
  const stateDir = harness.paths.stateDir;
  const socketPath = harness.paths.daemonSocketPath;
  const unitDir = join(harness.home, '.config', 'systemd', 'user');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const first = await startDaemon({
    socketPath,
    reporterSocketPath: harness.paths.socketPath,
    dbPath: harness.paths.dbFile,
    statusPath: harness.paths.statusFile,
    build: createHostServices().build,
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

  await ctx.harness.waitForGone('╭─ ');
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

  await ctx.harness.waitForGone('╭─ ');
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
