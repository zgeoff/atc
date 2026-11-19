import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { buildDaemonStatePaths } from '@atc/config';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';

function setupTest() {
  return startTestDaemon({
    mainClient: false,
    prefix: 'atc-daemon-',

    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it stops the daemon when its handle is disposed', async () => {
  const ctx = await setupTest();

  await ctx.daemon[Symbol.asyncDispose]();

  const statePaths = buildDaemonStatePaths(dirname(ctx.dbPath));

  expect(existsSync(statePaths.recordFile)).toBeFalse();
});

test('it releases nothing again when a stopped handle is disposed', async () => {
  const ctx = await setupTest();

  const stopped = ctx.daemon;

  await ctx.restart();

  const disposed = stopped[Symbol.asyncDispose]();

  await expect(disposed).toResolve();

  const statePaths = buildDaemonStatePaths(dirname(ctx.dbPath));

  expect(existsSync(statePaths.recordFile)).toBeTrue();
});
