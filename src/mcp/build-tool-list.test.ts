import { expect, test } from 'bun:test';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';

test('it lists one entry per defined tool in definition order', () => {
  expect(buildToolList(new Set(DAEMON_FEATURES)).map((tool) => tool.name)).toStrictEqual(
    MCP_TOOLS.map((tool) => tool.name),
  );
});

test('it lists each tool with only its name, description, schemas, and annotations', () => {
  expect(
    buildToolList(new Set(DAEMON_FEATURES)).map((tool) => Object.keys(tool).toSorted().join(',')),
  ).toSatisfyAll(
    (keys) =>
      keys === 'annotations,description,inputSchema,name' ||
      keys === 'annotations,description,inputSchema,name,outputSchema',
  );
});

test('it lists an output schema for the agent, message, and event tools', () => {
  expect(
    buildToolList(new Set(DAEMON_FEATURES))
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name),
  ).toStrictEqual(['atc_agents_list', 'atc_events_read', 'atc_session_message', 'atc_message_get']);
});

test('it leaves out the agents tool for a daemon that announces no features', () => {
  expect(buildToolList(new Set()).map((tool) => tool.name)).not.toContain('atc_agents_list');
});

test('it lists the message and event tools in their older form for a daemon that announces no features', () => {
  const tools = buildToolList(new Set());
  const messageGet = tools.find((tool) => tool.name === 'atc_message_get');
  const eventsRead = tools.find((tool) => tool.name === 'atc_events_read');

  if (messageGet === undefined || eventsRead === undefined) {
    throw new Error('message or event tool missing');
  }

  expect(messageGet.outputSchema).toBeUndefined();
  expect(eventsRead.outputSchema).toBeUndefined();
  expect(messageGet.inputSchema['properties']).toContainAllKeys(['message']);
  expect(eventsRead.inputSchema['properties']).toContainAllKeys(['cursor', 'limit', 'waitMs']);
});
