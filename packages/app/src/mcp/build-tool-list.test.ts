import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { getRecord } from '../shared/get-record';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';

test('it lists one entry per defined tool in definition order', () => {
  expect(
    buildToolList(new Set([...DAEMON_FEATURES, 'fleet.daemons']), null).map((tool) => tool.name),
  ).toStrictEqual(MCP_TOOLS.map((tool) => tool.name));
});

test('it leaves out the daemons tool and every daemon input for a caller of one daemon', () => {
  const tools = buildToolList(new Set(DAEMON_FEATURES), null);
  const spawn = tools.find((tool) => tool.name === 'atc_session_spawn');
  const dirs = tools.find((tool) => tool.name === 'atc_recent_dirs_list');

  invariant(spawn !== undefined && dirs !== undefined, 'spawn or dirs tool missing');

  expect(tools.map((tool) => tool.name)).not.toContain('atc_daemons_list');
  expect(getRecord(spawn.inputSchema, 'properties')).not.toContainKey('daemon');
  expect(dirs.inputSchema['properties']).toStrictEqual({});
});

test('it lists the agents tool without its output schema for a caller across named daemons', () => {
  const agents = buildToolList(new Set([...DAEMON_FEATURES, 'fleet.daemons']), null).find(
    (tool) => tool.name === 'atc_spawn_options_get',
  );

  invariant(agents !== undefined, 'agents tool missing');

  expect(agents).not.toContainKey('outputSchema');
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

test('it lists an output schema for the type, stop, spawn options, event, and message tools', () => {
  expect(
    buildToolList(new Set(DAEMON_FEATURES), null)
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name),
  ).toStrictEqual([
    'atc_terminal_type',
    'atc_session_stop',
    'atc_spawn_options_get',
    'atc_events_read',
    'atc_message_send',
    'atc_message_get',
  ]);
});

test('it leaves out the agents tool for a daemon that announces no features', () => {
  expect(buildToolList(new Set(), null).map((tool) => tool.name)).not.toContain(
    'atc_spawn_options_get',
  );
});

test('it offers the preview switch and no note text input on the events tool', () => {
  const eventsRead = buildToolList(new Set(DAEMON_FEATURES), null).find(
    (tool) => tool.name === 'atc_events_read',
  );

  invariant(eventsRead !== undefined, 'event tool missing');

  expect(eventsRead.inputSchema['properties']).toContainKey('previewOnly');
  expect(eventsRead.inputSchema['properties']).not.toContainKey('reportText');
});

test('it lists no tool that reads one note or resumes a session outside atc', () => {
  const names = buildToolList(new Set(DAEMON_FEATURES), null).map((tool) => tool.name);

  expect(names).not.toContain('atc_report_get');
  expect(names).not.toContain('atc_resume_command');
});

test('it lists the message and event tools in their older form for a daemon that announces no features', () => {
  const tools = buildToolList(new Set(), null);
  const messageGet = tools.find((tool) => tool.name === 'atc_message_get');
  const eventsRead = tools.find((tool) => tool.name === 'atc_events_read');

  invariant(messageGet !== undefined && eventsRead !== undefined, 'message or event tool missing');

  expect(messageGet.outputSchema).toBeUndefined();
  expect(eventsRead.outputSchema).toBeUndefined();
  expect(messageGet.inputSchema['properties']).toContainAllKeys(['message']);

  expect(eventsRead.inputSchema['properties']).toContainAllKeys([
    'cursor',
    'limit',
    'waitMs',
    'previewOnly',
  ]);
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

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(spawn.inputSchema['properties']).toContainAllKeys([
    'cwd',
    'name',
    'prompt',
    'agent',
    'detached',
  ]);
});

test('it lists the message tool without an idempotency key for a daemon that announces no features', () => {
  const message = buildToolList(new Set(), null).find((tool) => tool.name === 'atc_message_send');

  invariant(message !== undefined, 'message tool missing');

  expect(message.inputSchema['properties']).toContainAllKeys(['session', 'text', 'from']);
});

test('it lists the spawn and message tools with an idempotency key for a daemon that takes keys', () => {
  const tools = buildToolList(new Set(DAEMON_FEATURES), null);

  const keyed = tools
    .filter((tool) => JSON.stringify(tool.inputSchema).includes('"idempotencyKey"'))
    .map((tool) => tool.name);

  expect(keyed).toStrictEqual(['atc_session_spawn', 'atc_message_send']);
});

test('it lists the spawn tool with a target for a daemon that takes targets', () => {
  const spawn = buildToolList(new Set(DAEMON_FEATURES), null).find(
    (tool) => tool.name === 'atc_session_spawn',
  );

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(spawn.inputSchema['properties']).toContainKey('target');
});

test('it lists the spawn tool without a target for a daemon that predates targets', () => {
  const spawn = buildToolList(
    new Set(DAEMON_FEATURES.filter((feature) => feature !== 'spawn.target')),
    null,
  ).find((tool) => tool.name === 'atc_session_spawn');

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(getRecord(spawn.inputSchema, 'properties')).not.toContainKey('target');
});

test('it lists the spawn tool with a workspace for a daemon that takes workspaces', () => {
  const spawn = buildToolList(new Set(DAEMON_FEATURES), null).find(
    (tool) => tool.name === 'atc_session_spawn',
  );

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(spawn.inputSchema['properties']).toContainKey('workspace');
});

test('it lists the spawn tool without a workspace for a daemon that predates workspaces', () => {
  const spawn = buildToolList(
    new Set(DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace')),
    null,
  ).find((tool) => tool.name === 'atc_session_spawn');

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(getRecord(spawn.inputSchema, 'properties')).not.toContainKey('workspace');
});

test('it leaves out the forget tool for a daemon that does not announce session forgets', () => {
  const features = new Set(DAEMON_FEATURES.filter((feature) => feature !== 'session.forget'));

  expect(buildToolList(features, null).map((tool) => tool.name)).not.toContain(
    'atc_session_forget',
  );
});

test('it lists the forget tool for a daemon that announces session forgets', () => {
  expect(buildToolList(new Set(DAEMON_FEATURES), null).map((tool) => tool.name)).toContain(
    'atc_session_forget',
  );
});
