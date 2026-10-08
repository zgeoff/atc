import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { isRecord } from '../src/shared/report';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';
import { startStubLegacyDaemon } from '../src/test-utils/start-stub-legacy-daemon';

async function setupTest() {
  const mcpHome = setupMCPHome();
  const legacy = startStubLegacyDaemon(join(mcpHome.home, 'atc-daemon.sock'));

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { legacy, mcp };
}

test('it leaves the agent list out of the tools for an older daemon', async () => {
  const ctx = await setupTest();
  const response = await ctx.mcp.sendRequest('tools/list');

  const result = response['result'];

  invariant(isRecord(result) && Array.isArray(result['tools']), 'tools/list returned no tools');

  expect(result['tools']).not.toPartiallyContain({ name: 'atc_agents_list' });
});

test('it refuses a call an older daemon cannot serve without sending it', async () => {
  const ctx = await setupTest();

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
