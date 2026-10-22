import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTUIHarness } from '@atc/test-utils';
import { startTUIDaemon } from './start-tui-daemon';

// A harness home with its config written and no client booted.
function setupTest() {
  return { tui: startTUIHarness() };
}

test('it boots the client against the daemon in the test process and starts no daemon process', async () => {
  const ctx = setupTest();

  await startTUIDaemon(ctx.tui);

  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBeFalse();
});

test('it serves at the home socket and gives sessions the harness HOME, where the stand-in agent reads its scenario', async () => {
  const ctx = setupTest();

  await startTUIDaemon(ctx.tui);

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.sock'))).toBeTrue();
  expect(process.env['HOME']).toBe(ctx.tui.home);
});
