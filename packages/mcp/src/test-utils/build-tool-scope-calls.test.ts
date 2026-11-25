import { expect, test } from 'bun:test';
import { MCP_TOOLS } from '../tools/mcp-tools';
import { buildToolScopeCalls } from './build-tool-scope-calls';

test('it holds a call for every tool', () => {
  expect(MCP_TOOLS.map((tool) => buildToolScopeCalls(tool.name).length)).toSatisfyAll(
    (count) => count > 0,
  );
});
