import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '../src/daemon/daemon';
import { getBuild } from '../src/shared/get-build';
import { buildMockAgentAdapter } from '../src/test-utils/build-mock-agent-adapter';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

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

  expect(existsSync(join(ctx.home, '.local', 'state', 'atc', 'atc.db'))).toBe(false);

  const daemon = await startDaemon({
    socketPath: join(ctx.home, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.home, 'atc.sock'),
    dbPath: join(ctx.home, '.local', 'state', 'atc', 'atc.db'),
    statusPath: join(ctx.home, '.local', 'state', 'atc', 'status.json'),
    build: getBuild(),
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => daemon.stop());

  await ctx.waitFor('no session');

  expect(ctx.read()).toInclude('atc');
});

test('it reconnects a client after a managed daemon restarts without starting a replacement', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const options = {
    socketPath: join(ctx.home, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.home, 'atc.sock'),
    dbPath: join(ctx.home, '.local', 'state', 'atc', 'atc.db'),
    statusPath: join(ctx.home, '.local', 'state', 'atc', 'status.json'),
    build: getBuild(),
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

  expect(existsSync(join(ctx.home, '.local', 'state', 'atc', 'atc.db'))).toBe(true);
});
