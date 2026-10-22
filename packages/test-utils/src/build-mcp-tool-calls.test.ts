import { expect, mock, test } from 'bun:test';
import { buildMCPToolCalls } from './build-mcp-tool-calls';

test('it sends a tool call as a tools/call request and parses its result', async () => {
  const sendRequest = mock(() =>
    Promise.resolve({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'listed' }], structuredContent: { count: 2 } },
    }),
  );

  const calls = buildMCPToolCalls(sendRequest);

  const result = await calls.sendToolCall('atc_session_list', { all: true });

  expect(sendRequest).toHaveBeenCalledExactlyOnceWith('tools/call', {
    name: 'atc_session_list',
    arguments: { all: true },
  });

  expect(result).toStrictEqual({ isError: undefined, text: 'listed', structured: { count: 2 } });
});

test('it resolves a spawn with the session id the spawn tool returns', async () => {
  const sendRequest = mock(() =>
    Promise.resolve({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'spawned' }], structuredContent: { id: 's-7' } },
    }),
  );

  const calls = buildMCPToolCalls(sendRequest);

  const id = await calls.spawnSession({ agent: 'claude' });

  expect(id).toBe('s-7');

  expect(sendRequest).toHaveBeenCalledExactlyOnceWith('tools/call', {
    name: 'atc_session_spawn',
    arguments: { agent: 'claude' },
  });
});

test('it rejects a spawn whose result holds no session id', () => {
  const calls = buildMCPToolCalls(() =>
    Promise.resolve({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'no agent named nope' }], isError: true },
    }),
  );

  expect(calls.spawnSession({ agent: 'nope' })).rejects.toThrowWithMessage(
    TypeError,
    'spawn returned no session id: no agent named nope',
  );
});
