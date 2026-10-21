import { expect, test } from 'bun:test';
import { buildMockAgentAdapter, spawnNamedSession, waitFor } from '@atc/test-utils';
import { startTestDaemon } from './start-test-daemon';

test('it runs a spawned harness on the local pseudo-terminal when the options name no target', async () => {
  const harness = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: 'sh', args: ['-c', 'echo printed-by-a-real-process; sleep 30'] }),
      }),
    }),
  });

  const session = await spawnNamedSession(
    (method, params) => harness.client.sendRequest(method, params),
    'one',
    harness.directory,
  );

  await waitFor(async () => {
    const screen = await harness.client.sendRequest('session.screen', { session });

    expect(screen['text']).toInclude('printed-by-a-real-process');
  });
});
