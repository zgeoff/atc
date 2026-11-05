import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import {
  buildMockAgentAdapter,
  registerTestCleanup,
  startStubLegacyDaemon,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';
import { createHostServices } from '../packages/app/src/create-host-services';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';

function setupTest() {
  return startTUIHarness();
}

test('it waits for a managed daemon instead of starting one while the unit is down', async () => {
  const ctx = setupTest();
  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  ctx.reset();
  ctx.boot();

  await ctx.waitFor('waiting for atc-daemon.service');

  expect(existsSync(ctx.paths.daemonRecordFile)).toBe(false);

  const daemon = await startDaemon({
    socketPath: ctx.paths.daemonSocketPath,
    reporterSocketPath: ctx.paths.socketPath,
    dbPath: ctx.paths.dbFile,
    statusPath: ctx.paths.statusFile,
    build: createHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => daemon.stop());

  await ctx.waitFor('no session');

  expect(ctx.read()).toInclude('atc');
});

test('it reconnects a client after a managed daemon restarts without starting a replacement', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.paths.stateDir, { recursive: true });

  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const options = {
    socketPath: ctx.paths.daemonSocketPath,
    reporterSocketPath: ctx.paths.socketPath,
    dbPath: ctx.paths.dbFile,
    statusPath: ctx.paths.statusFile,
    build: createHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  };

  const first = await startDaemon(options);

  registerTestCleanup(() => first.stop());

  ctx.boot();

  await ctx.waitFor('no session');

  ctx.reset();

  await first.stop();
  await ctx.waitFor('waiting for daemon');

  const second = await startDaemon(options);

  registerTestCleanup(() => second.stop());

  await waitFor(() => {
    expect(second.countClients()).toBe(1);
  });

  await ctx.waitFor('idle');

  ctx.reset();
  ctx.write('?');

  await ctx.waitFor('keys');

  expect(second.countClients()).toBe(1);
});

test('it starts a daemon when no user unit manages it', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('no session');

  expect(existsSync(ctx.paths.dbFile)).toBe(true);
});

test('it reconnects again when a replacement closes during the fleet refresh', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.paths.stateDir, { recursive: true });

  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const options = {
    socketPath: ctx.paths.daemonSocketPath,
    reporterSocketPath: ctx.paths.socketPath,
    dbPath: ctx.paths.dbFile,
    statusPath: ctx.paths.statusFile,
    build: createHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  };

  const first = await startDaemon(options);

  registerTestCleanup(() => first.stop());

  ctx.boot();

  await ctx.waitFor('no session');

  ctx.reset();

  await first.stop();
  await ctx.waitFor('waiting for daemon');

  const transient = startStubLegacyDaemon(options.socketPath, { closeOnRequest: 'session.list' });

  await waitFor(() => {
    expect(transient.requests).toPartiallyContain({ method: 'session.list' });
  });

  transient.stop();

  const healthy = await startDaemon(options);

  registerTestCleanup(() => healthy.stop());

  await waitFor(() => {
    expect(healthy.countClients()).toBe(1);
  });

  expect(transient.requests).toPartiallyContain({ method: 'session.list' });
  expect(healthy.countClients()).toBe(1);
});

test('it keeps help open when a managed daemon returns', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.paths.stateDir, { recursive: true });

  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const options = {
    socketPath: ctx.paths.daemonSocketPath,
    reporterSocketPath: ctx.paths.socketPath,
    dbPath: ctx.paths.dbFile,
    statusPath: ctx.paths.statusFile,
    build: createHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  };

  const first = await startDaemon(options);

  registerTestCleanup(() => first.stop());

  ctx.boot();

  await ctx.waitFor('no session');

  ctx.reset();

  await first.stop();
  await ctx.waitFor('waiting for daemon');

  ctx.write('?');

  await ctx.waitFor('attach the selected session');

  ctx.reset();

  const second = await startDaemon(options);

  registerTestCleanup(() => second.stop());

  await waitFor(() => {
    expect(second.countClients()).toBe(1);
  });

  await ctx.waitFor('idle');

  expect(ctx.read()).not.toInclude('no sessions — n to spawn');

  ctx.write('q');

  await ctx.waitFor('no sessions — n to spawn');
});
