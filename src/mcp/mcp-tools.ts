import { z } from 'zod';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import type { GrantScope } from '../shared/grant-scope';

const NO_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(z.strictObject({}));

/**
 * The session id shape MCP tool schemas require: present and described.
 * The daemon's wire request schemas share a defaulted-session shape
 * instead, since they tolerate an absent session by defaulting it to an
 * empty string.
 */
const SESSION_ID_BASE = z.object({
  session: z.string().describe('The atc session id, from atc_session_list'),
});

const SESSION_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(SESSION_ID_BASE.strict());
const SPAWN_SCHEMA = REQUEST_PARAM_SCHEMAS['session.spawn'];

const SPAWN_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    cwd: SPAWN_SCHEMA.shape.cwd.describe('Absolute path of the working directory'),
    name: SPAWN_SCHEMA.shape.name.describe('Session name; defaults to the directory basename'),
    prompt: SPAWN_SCHEMA.shape.prompt.describe('First message for the session'),
    agent: SPAWN_SCHEMA.shape.agent.describe(
      'Which registered agent id to spawn; defaults to claude',
    ),
    detached: z
      .boolean()
      .optional()
      .describe(
        'Spawn a top-level session. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, killed with it.',
      ),
  }),
  { io: 'input' },
);

const SESSION_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.extend({
    cursor: z
      .string()
      .optional()
      .describe(
        'The cursor a previous atc_session_read returned; omit to read from the start of the conversation',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Most rows to return; defaults to 50'),
  }).strict(),
  { io: 'input' },
);

const EVENTS_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    cursor: z
      .string()
      .optional()
      .describe(
        'The cursor a previous atc_events_read returned; omit to get the most recent events',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Most events to return; defaults to 50'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe(
        'How long to wait for a new event when none is pending, in milliseconds; defaults to 0, capped at 30000. Keep it short.',
      ),
  }),
  { io: 'input' },
);

interface MCPToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

interface MCPToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: MCPToolAnnotations;
  readonly scope: GrantScope;
}

const READ_ONLY: MCPToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const ADDITIVE: MCPToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

const DESTRUCTIVE: MCPToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

// A tool that starts an agent or puts text in front of one reaches past atc: the agent acts on
// what it reads, outside atc's control.
const AGENT_FACING: MCPToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

const AGENT_FACING_DESTRUCTIVE: MCPToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

export const MCP_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_session_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'List every session the atc daemon hosts: id, name, working directory, state (running, needs_you, done, exited), unread flag, and last activity.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'atc_session_spawn',
    annotations: AGENT_FACING,
    scope: 'spawn',
    description:
      'Spawn a new session in a directory. Optional agent is an agent id the daemon has registered, such as claude, grok, or codex; omitted agent is always Claude, never the TUI last-used value. An unregistered id is rejected. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true. Returns the new session descriptor. Give it a prompt to start it working immediately.',
    inputSchema: SPAWN_INPUT,
  },
  {
    name: 'atc_session_input',
    annotations: AGENT_FACING_DESTRUCTIVE,
    scope: 'spawn',
    description:
      'Type a line of text into a running session, as if the operator typed it and pressed enter. Use it to answer a session that is waiting on input.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        text: { type: 'string', description: 'The line to type; a newline is appended' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_screen',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read the current terminal screen of a session as plain text, without attaching to it. Use it to see what a session printed or what it is waiting on before answering it with atc_session_input. A killed session keeps its last screen.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_update',
    annotations: ADDITIVE,
    scope: 'message',
    description:
      'Rename and/or pin a session. Renames stick against auto-summaries; pinned sessions lead every list. A sub-session pins with its parent, so pin the parent instead. Use this to organise the fleet: name sessions after their task.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        name: { type: 'string', description: 'New display name; omit to keep' },
        pinned: { type: 'boolean', description: 'Pin or unpin; omit to keep' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_kill',
    annotations: DESTRUCTIVE,
    scope: 'kill',
    description: 'Kill a session. A second kill on a dead session removes it from the list.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_ack',
    annotations: ADDITIVE,
    scope: 'message',
    description: 'Clear a session unread flag without attaching to it.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_resume_command',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Build the shell command that reopens a session outside atc (cd into its directory and claude --resume its id).',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_dirs_list',
    annotations: READ_ONLY,
    scope: 'read',
    description: 'List directories sessions were previously spawned from, most recent first.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'atc_session_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read one session in a single call: its descriptor (state, unread flag, last activity message), the prompt it was spawned with, when it last reported activity, the prompt or question it is waiting on while it needs you (read-only; answer it with atc_session_input), and the final message of its latest finished turn.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read a session's conversation a page at a time, oldest first: user and assistant messages with tool uses summarised. Pass the returned cursor to continue where you left off; more is true when the page stopped before the end. Claude sessions only; other agents answer unsupported.",
    inputSchema: SESSION_READ_INPUT,
  },
  {
    name: 'atc_events_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Catch up on the fleet: session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-accepted, message-delivered, message-answered), and reports (report) since a cursor, oldest first, each with the session id and name. A message event carries the message id; read the full message with atc_message_get. A report event carries its label. Without a cursor it returns the most recent events. Pass the returned cursor next time. waitMs holds the call open until an event arrives.',
    inputSchema: EVENTS_READ_INPUT,
  },
  {
    name: 'atc_session_message',
    annotations: AGENT_FACING,
    scope: 'message',
    description:
      "Send a session a message and get its id back. Follow up by polling atc_message_get with the id until its status is answered, which returns the session's final reply; don't read the session's screen or transcript to check on it. The message waits in the session inbox until the session takes it, and its status moves accepted, delivered, answered. A message is refused as unsupported when the session's agent has no message tap (Grok, Codex), or when a Claude session reported SessionStart more than 15 seconds ago and no tap has attached since. It is refused as session_dead when the session has no live process and as no_such_session for an unknown id. Otherwise it queues, including while a session restores or after its tap dropped. The message is never typed into the terminal.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_session_list' },
        text: { type: 'string', description: 'The message text' },
        from: {
          type: 'string',
          description:
            'Who the message is from; defaults to the calling session id, or mcp outside a session',
        },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_message_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read one message sent with atc_session_message: its id, session, from, text, status (accepted, delivered, or answered), the answer once answered, and the sentAt, deliveredAt, and answeredAt timestamps. Poll it until the status is answered.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message id atc_session_message returned' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];
