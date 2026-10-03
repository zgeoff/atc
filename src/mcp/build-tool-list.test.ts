import { expect, test } from 'bun:test';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';

test('it lists one entry per defined tool in definition order', () => {
  expect(buildToolList(new Set(DAEMON_FEATURES), null).map((tool) => tool.name)).toStrictEqual(
    MCP_TOOLS.map((tool) => tool.name),
  );
});

test('it lists each tool with only its name, description, schemas, and annotations', () => {
  expect(
    buildToolList(new Set(DAEMON_FEATURES), null).map((tool) =>
      Object.keys(tool).toSorted().join(','),
    ),
  ).toSatisfyAll(
    (keys) =>
      keys === 'annotations,description,inputSchema,name' ||
      keys === 'annotations,description,inputSchema,name,outputSchema',
  );
});

test('it lists an output schema for the agent, message, and event tools', () => {
  expect(
    buildToolList(new Set(DAEMON_FEATURES), null)
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name),
  ).toStrictEqual(['atc_agents_list', 'atc_events_read', 'atc_session_message', 'atc_message_get']);
});

test('it leaves out the agents tool for a daemon that announces no features', () => {
  expect(buildToolList(new Set(), null).map((tool) => tool.name)).not.toContain('atc_agents_list');
});

test('it lists the message and event tools in their older form for a daemon that announces no features', () => {
  const tools = buildToolList(new Set(), null);
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

test('it mentions no agent id the host has not registered in any description', () => {
  const tools = buildToolList(new Set(DAEMON_FEATURES), [
    { id: 'claude', installed: true },
    { id: 'zai', installed: false },
  ]);

  const descriptions = JSON.stringify(
    tools.map((tool) => ({ description: tool.description, input: tool.inputSchema })),
  ).toLowerCase();

  expect(['grok', 'codex', 'gemini'].filter((id) => descriptions.includes(id))).toStrictEqual([]);
  expect(descriptions).toInclude('zai (not installed)');
});

test('it builds the same schemas whichever agents the host registers', () => {
  const unnamed = buildToolList(new Set(DAEMON_FEATURES), null);
  const named = buildToolList(new Set(DAEMON_FEATURES), [{ id: 'claude', installed: true }]);

  const stripped = [unnamed, named].map((tools) =>
    JSON.stringify(tools, (key, value: unknown) => (key === 'description' ? undefined : value)),
  );

  expect(stripped[0]).toBe(stripped[1]);
});

test('it lists the spawn tool without model and effort for a daemon that announces no features', () => {
  const spawn = buildToolList(new Set(), null).find((tool) => tool.name === 'atc_session_spawn');

  if (spawn === undefined) {
    throw new Error('spawn tool missing');
  }

  expect(spawn.inputSchema['properties']).toContainAllKeys([
    'cwd',
    'name',
    'prompt',
    'agent',
    'detached',
  ]);
});

test('it lists the message tool without an idempotency key for a daemon that announces no features', () => {
  const message = buildToolList(new Set(), null).find(
    (tool) => tool.name === 'atc_session_message',
  );

  if (message === undefined) {
    throw new Error('message tool missing');
  }

  expect(message.inputSchema['properties']).toContainAllKeys(['session', 'text', 'from']);
});

test('it lists the spawn and message tools with an idempotency key for a daemon that takes keys', () => {
  const tools = buildToolList(new Set(DAEMON_FEATURES), null);

  const keyed = tools
    .filter((tool) => JSON.stringify(tool.inputSchema).includes('"idempotencyKey"'))
    .map((tool) => tool.name);

  expect(keyed).toStrictEqual(['atc_session_spawn', 'atc_session_message']);
});
