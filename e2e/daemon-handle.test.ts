import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockAgentAdapter } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// Each test stops the daemon through its handle, so the harness opens no main
// client that would outlive it.
function setupTest() {
  return startTestDaemon({
    mainClient: false,
    prefix: 'atc-daemon-',

    // Every spawn needs a Claude adapter; this one runs a sleep.
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it stops the daemon when its handle is disposed', async () => {
  const ctx = await setupTest();

  await ctx.daemon[Symbol.asyncDispose]();

  expect(existsSync(join(ctx.dir, 'daemon.json'))).toBeFalse();
});

test('it releases nothing again when a stopped handle is disposed', async () => {
  const ctx = await setupTest();

  const stopped = ctx.daemon;

  await ctx.restart();

  const disposed = stopped[Symbol.asyncDispose]();

  await expect(disposed).toResolve();

  expect(existsSync(join(ctx.dir, 'daemon.json'))).toBeTrue();
});
