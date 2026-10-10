import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { getRecord } from '../src/shared/get-record';
import { getRecords } from '../src/test-utils/get-records';
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

  const tools = getRecords(getRecord(response, 'result'), 'tools');

  expect(tools.map((tool) => tool['name'])).toIncludeSameMembers([
    'atc_sessions_list',
    'atc_session_spawn',
    'atc_terminal_type',
    'atc_terminal_read',
    'atc_session_update',
    'atc_session_stop',
    'atc_session_mark_read',
    'atc_recent_dirs_list',
    'atc_session_get',
    'atc_transcript_read',
    'atc_events_read',
    'atc_message_send',
    'atc_message_get',
  ]);
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
