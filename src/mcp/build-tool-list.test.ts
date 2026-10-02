import { expect, test } from 'bun:test';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';

test('it lists one entry per defined tool in definition order', () => {
  expect(buildToolList().map((tool) => tool.name)).toStrictEqual(
    MCP_TOOLS.map((tool) => tool.name),
  );
});

test('it lists each tool with only its name, description, input schema, and annotations', () => {
  expect(buildToolList().map((tool) => Object.keys(tool).toSorted().join(','))).toSatisfyAll(
    (keys) => keys === 'annotations,description,inputSchema,name',
  );
});
