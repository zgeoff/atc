import { expect, test } from 'bun:test';
import { MCP_TOOLS } from './mcp-tools';

type ToolDefinition = (typeof MCP_TOOLS)[number];

test('it gives every tool one of the four scopes', () => {
  expect(MCP_TOOLS).toSatisfyAll((tool: ToolDefinition) =>
    ['read', 'message', 'spawn', 'kill'].includes(tool.scope),
  );
});

test("it pins every tool's scope and safety hints", () => {
  expect(
    Object.fromEntries(
      MCP_TOOLS.map((tool) => [tool.name, { scope: tool.scope, ...tool.annotations }]),
    ),
  ).toStrictEqual({
    atc_session_list: {
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
    atc_session_input: {
      scope: 'spawn',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    atc_session_screen: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_update: {
      scope: 'message',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_session_kill: {
      scope: 'kill',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    atc_session_ack: {
      scope: 'message',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_resume_command: {
      scope: 'read',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    atc_dirs_list: {
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
    atc_session_read: {
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
    atc_session_message: {
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
    (tool: ToolDefinition) => tool.annotations.readOnlyHint,
  );
});

test('it marks no tool outside the read scope read-only', () => {
  expect(MCP_TOOLS.filter((tool) => tool.scope !== 'read')).toSatisfyAll(
    (tool: ToolDefinition) => !tool.annotations.readOnlyHint,
  );
});

test('it names every tool once', () => {
  expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
});
