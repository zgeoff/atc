import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { getRecord } from '../shared/get-record';
import { MCP_TOOLS } from './mcp-tools';

test('it declares an agents result whose kind can be any string an adapter declares', () => {
  const schema = MCP_TOOLS.find((tool) => tool.name === 'atc_spawn_options_get')?.outputSchema;

  invariant(schema !== undefined, 'the agents tool declares no output schema');

  const result = {
    daemon: { hostname: 'host', platform: 'linux', arch: 'x64', build: 'atc/test-build' },
    agents: [
      {
        id: 'acme',
        label: 'Acme Agent',
        kind: 'acme-cli',
        installed: true,
        capabilities: {
          spawn: true,
          readTranscript: false,
          message: false,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
        spawnOptions: {
          model: {
            supported: true,
            available: true,
            values: null,
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: null,
          },
          effort: {
            supported: false,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
        },
      },
    ],
  };

  const parsed = z.fromJSONSchema(schema).safeParse(result);

  expect(parsed.data).toStrictEqual(result);
});

test('it rejects an agents result whose installed flag is not a boolean', () => {
  const schema = MCP_TOOLS.find((tool) => tool.name === 'atc_spawn_options_get')?.outputSchema;

  invariant(schema !== undefined, 'the agents tool declares no output schema');

  const result = {
    daemon: { hostname: 'host', platform: 'linux', arch: 'x64', build: 'atc/test-build' },
    agents: [
      {
        id: 'acme',
        label: 'Acme Agent',
        kind: 'acme-cli',
        installed: 'yes',
        capabilities: {
          spawn: true,
          readTranscript: false,
          message: false,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
        spawnOptions: {
          model: {
            supported: true,
            available: true,
            values: null,
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: null,
          },
          effort: {
            supported: false,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
        },
      },
    ],
  };

  const parsed = z.fromJSONSchema(schema).safeParse(result);

  expect(parsed.error?.issues).toPartiallyContain({ path: ['agents', 0, 'installed'] });
});

test('it gives every tool one of the four scopes', () => {
  expect(MCP_TOOLS).toSatisfyAll((tool: (typeof MCP_TOOLS)[number]) =>
    ['read', 'message', 'spawn', 'kill'].includes(tool.scope),
  );
});

test('it gives each tool its scope and safety hints as the tool table lists them', () => {
  expect(
    Object.fromEntries(
      MCP_TOOLS.map((tool) => [tool.name, { scope: tool.scope, ...tool.annotations }]),
    ),
  ).toStrictEqual({
    atc_sessions_list: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_spawn: {
      scope: 'spawn',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    atc_terminal_type: {
      scope: 'spawn',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    atc_terminal_read: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_scope_add: {
      scope: 'spawn',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_update: {
      scope: 'message',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_stop: {
      scope: 'kill',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    atc_session_forget: {
      scope: 'kill',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    atc_session_mark_read: {
      scope: 'message',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_recent_dirs_list: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_daemons_list: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_spawn_options_get: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_get: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_transcript_read: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_events_read: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_message_send: {
      scope: 'message',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    atc_message_get: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  });
});

test('it marks every read-scoped tool read-only', () => {
  expect(MCP_TOOLS.filter((tool) => tool.scope === 'read')).toSatisfyAll(
    (tool: (typeof MCP_TOOLS)[number]) => tool.annotations.readOnlyHint,
  );
});

test('it marks no tool outside the read scope read-only', () => {
  expect(MCP_TOOLS.filter((tool) => tool.scope !== 'read')).toSatisfyAll(
    (tool: (typeof MCP_TOOLS)[number]) => !tool.annotations.readOnlyHint,
  );
});

test('it names every tool once', () => {
  expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
});

test('it names only tools that exist wherever a description refers to a tool', () => {
  const names = new Set(MCP_TOOLS.map((tool) => tool.name));

  const text = JSON.stringify(MCP_TOOLS.map((tool) => [tool.description, tool.inputSchema]));

  const referred = new Set(text.match(/atc_[a-z]+(?:_[a-z]+)+/g));

  expect([...referred].filter((name) => !names.has(name))).toStrictEqual([]);
});

test('it declares the written flag as the result of typing a line', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'atc_terminal_type');

  expect(tool?.outputSchema).toStrictEqual({
    type: 'object',
    properties: { written: { type: 'boolean' } },
    required: ['written'],
  });
});

test('it declares the stopped flag as the result of stopping a session', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'atc_session_stop');

  expect(tool?.outputSchema).toMatchObject({
    type: 'object',
    properties: { stopped: { type: 'boolean' } },
    required: ['stopped'],
  });
});

test('it describes the gateway fields of an events page in its output schema', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'atc_events_read');
  const properties = getRecord(tool?.outputSchema ?? {}, 'properties');

  expect(Object.keys(properties)).toIncludeAllMembers(['unavailable', 'started', 'truncated']);
  expect(getRecord(properties, 'unavailable')['description']).toBeString();
});

test('it lists the sources a spawn options result holds', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'atc_spawn_options_get');

  expect(getRecord(tool?.outputSchema ?? {}, 'properties')).toContainKey('sources');
});
