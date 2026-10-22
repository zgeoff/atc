import { expect, test } from 'bun:test';
import { parseMCPToolResult } from './parse-mcp-tool-result';

test('it parses a tool result into its error flag, text and structured content', () => {
  expect(
    parseMCPToolResult({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{"id":"s-1"}' }],
        structuredContent: { id: 's-1' },
      },
    }),
  ).toStrictEqual({ isError: undefined, text: '{"id":"s-1"}', structured: { id: 's-1' } });
});

test('it keeps the error flag of a refused tool call', () => {
  expect(
    parseMCPToolResult({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'no such session' }], isError: true },
    }),
  ).toStrictEqual({ isError: true, text: 'no such session', structured: undefined });
});

test.each([
  ['no result', { jsonrpc: '2.0', id: 1, error: { code: -32_601, message: 'nope' } }],
  ['two content items', { result: { content: [{ text: 'a' }, { text: 'b' }] } }],
  ['a content item without text', { result: { content: [{ type: 'image' }] } }],
  [
    'structured content that is not an object',
    { result: { content: [{ text: 'a' }], structuredContent: 'a' } },
  ],
])('it rejects a response with %s', (_label, response) => {
  expect(() => parseMCPToolResult(response)).toThrowWithMessage(
    TypeError,
    /^tool call returned an unexpected result/u,
  );
});
