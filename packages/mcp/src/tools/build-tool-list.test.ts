import { expect, test } from 'bun:test';
import { getRecord } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';

test('it lists one entry per defined tool in definition order', () => {
  expect(buildToolList(new Set(['fleet.daemons']), null).map((tool) => tool.name)).toStrictEqual(
    MCP_TOOLS.map((tool) => tool.name),
  );
});

test('it leaves out the daemons tool and every daemon input for a caller of one daemon', () => {
  const tools = buildToolList(new Set(), null);
  const spawn = tools.find((tool) => tool.name === 'atc_session_spawn');
  const dirs = tools.find((tool) => tool.name === 'atc_recent_dirs_list');

  invariant(spawn !== undefined && dirs !== undefined, 'spawn or dirs tool missing');

  expect(tools.map((tool) => tool.name)).not.toContain('atc_daemons_list');
  expect(getRecord(spawn.inputSchema, 'properties')).not.toContainKey('daemon');
  expect(dirs.inputSchema['properties']).toStrictEqual({});
});

test('it lists the agents tool without its output schema for a caller across named daemons', () => {
  const agents = buildToolList(new Set(['fleet.daemons']), null).find(
    (tool) => tool.name === 'atc_spawn_options_get',
  );

  invariant(agents !== undefined, 'agents tool missing');

  expect(agents).not.toContainKey('outputSchema');
});

test('it lists each tool with only its name, description, schemas, and annotations', () => {
  expect(
    buildToolList(new Set(), null).map((tool) => Object.keys(tool).toSorted().join(',')),
  ).toSatisfyAll(
    (keys) =>
      keys === 'annotations,description,inputSchema,name' ||
      keys === 'annotations,description,inputSchema,name,outputSchema',
  );
});

test('it lists an output schema for every tool whose result is data', () => {
  expect(
    buildToolList(new Set(), null)
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name),
  ).toStrictEqual([
    'atc_sessions_list',
    'atc_session_spawn',
    'atc_terminal_type',
    'atc_terminal_choose',
    'atc_session_scope_add',
    'atc_session_stop',
    'atc_session_forget',
    'atc_session_adopt',
    'atc_session_auth_rebind',
    'atc_recent_dirs_list',
    'atc_spawn_options_get',
    'atc_session_get',
    'atc_transcript_read',
    'atc_events_read',
    'atc_message_send',
    'atc_message_get',
  ]);
});

test('it offers the preview switch and no note text input on the events tool', () => {
  const eventsRead = buildToolList(new Set(), null).find((tool) => tool.name === 'atc_events_read');

  invariant(eventsRead !== undefined, 'event tool missing');

  expect(eventsRead.inputSchema['properties']).toContainKey('previewOnly');
  expect(eventsRead.inputSchema['properties']).not.toContainKey('reportText');
});

test('it lists no tool that reads one note or resumes a session outside atc', () => {
  const names = buildToolList(new Set(), null).map((tool) => tool.name);

  expect(names).not.toContain('atc_report_get');
  expect(names).not.toContain('atc_resume_command');
});

test('it mentions no agent id the host has not registered in any description', () => {
  const tools = buildToolList(new Set(), [
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
  const unnamed = buildToolList(new Set(), null);
  const named = buildToolList(new Set(), [{ id: 'claude', installed: true }]);

  const stripped = [unnamed, named].map((tools) =>
    JSON.stringify(tools, (key, value: unknown) => (key === 'description' ? undefined : value)),
  );

  expect(stripped[0]).toBe(stripped[1]);
});

test('it lists the spawn and message tools with an idempotency key', () => {
  const tools = buildToolList(new Set(), null);

  const keyed = tools
    .filter((tool) => JSON.stringify(tool.inputSchema).includes('"idempotencyKey"'))
    .map((tool) => tool.name);

  expect(keyed).toStrictEqual(['atc_session_spawn', 'atc_message_send']);
});

test('it lists the spawn tool with every option a spawn takes', () => {
  const spawn = buildToolList(new Set(), null).find((tool) => tool.name === 'atc_session_spawn');

  invariant(spawn !== undefined, 'spawn tool missing');

  expect(getRecord(spawn.inputSchema, 'properties')).toContainKeys([
    'model',
    'effort',
    'pluginDirs',
    'target',
    'workspace',
    'trustClonedWorkspace',
    'scope',
  ]);
});

test('it lists the update tool with a name and a parent', () => {
  const update = buildToolList(new Set(), null).find((tool) => tool.name === 'atc_session_update');

  invariant(update !== undefined, 'update tool missing');

  expect(getRecord(update.inputSchema, 'properties')).toContainKeys(['name', 'parent']);
});

test('it lists the forget tool', () => {
  expect(buildToolList(new Set(), null).map((tool) => tool.name)).toContain('atc_session_forget');
});
