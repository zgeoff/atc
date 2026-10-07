import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isRecord } from '../src/shared/report';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startLegacyDaemon } from '../src/test-utils/start-legacy-daemon';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());
  const legacy = startLegacyDaemon(join(mcpHome.home, 'atc-daemon.sock'));

  stack.defer(() => {
    legacy.stop();
  });

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { legacy, mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it leaves the agent list out of the tools for an older daemon', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('tools/list');

  const result = response['result'];

  if (!isRecord(result) || !Array.isArray(result['tools'])) {
    throw new TypeError('tools/list returned no tools');
  }

  expect(result['tools']).not.toPartiallyContain({ name: 'atc_agents_list' });
});

test('it refuses a call an older daemon cannot serve without sending it', async () => {
  await using ctx = await setupTest();

  const refused = await ctx.mcp.sendToolCall('atc_message_get', {
    message: 'm-legacy',
    waitMs: 4000,
  });

  expect(refused).toStrictEqual({
    isError: true,
    text: expect.toStartWith('daemon_outdated: '),
    structured: undefined,
  });

  expect(ctx.legacy.requests.map((request) => request.m)).not.toContain('message.get');
});
