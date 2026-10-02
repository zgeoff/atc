import { z } from 'zod';
import type { DaemonFeature } from '../protocol/daemon-features';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import type { GrantScope } from '../shared/grant-scope';
import { buildSpawnDescriptions } from './build-spawn-descriptions';

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
const SPAWN_AGENT_DESCRIPTION = buildSpawnDescriptions(null).agent;

const SPAWN_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    cwd: SPAWN_SCHEMA.shape.cwd.describe('Absolute path of the working directory'),
    name: SPAWN_SCHEMA.shape.name.describe('Session name; defaults to the directory basename'),
    prompt: SPAWN_SCHEMA.shape.prompt.describe('First message for the session'),
    agent: SPAWN_SCHEMA.shape.agent.describe(SPAWN_AGENT_DESCRIPTION),
    model: SPAWN_SCHEMA.shape.model.describe(
      "Model for the new session: an alias or a full model name, at most 200 characters, never starting with '-'. It reaches the agent CLI as its own argument. Refused when the agent takes no model; spawnOptions.model in atc_agents_list holds each agent's support, default, and examples. Omit it to keep the agent's configured default.",
    ),
    effort: SPAWN_SCHEMA.shape.effort.describe(
      "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_agents_list. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
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

const WAIT_MS = z.number().int().min(0).max(30_000).optional();

const EVENTS_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    session: z
      .string()
      .optional()
      .describe(
        "An atc session id; limits the read to that session's events. Cursors stay valid across filtered and unfiltered reads",
      ),
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
    waitMs: WAIT_MS.describe(
      'How long to wait for a new event when none is pending, in milliseconds; defaults to 0, capped at 30000. Keep it short.',
    ),
  }),
  { io: 'input' },
);

const MESSAGE_GET_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    message: z.string().describe('The message id atc_session_message returned'),
    waitMs: WAIT_MS.describe(
      'How long to hold the call until the message status changes from what it was when you called, in milliseconds; defaults to 0, capped at 30000',
    ),
  }),
  { io: 'input' },
);

// Output schemas leave further properties open, so a field the daemon adds
// later never fails a client that validates results against them.
const MESSAGE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    session: { type: 'string' },
    from: { type: 'string' },
    text: { type: 'string' },
    status: { type: 'string', enum: ['accepted', 'delivered', 'answered'] },
    answer: { type: 'string' },
    turn: { type: ['string', 'null'] },
    answeredWith: { type: 'array', items: { type: 'string' } },
    sentAt: { type: 'number' },
    deliveredAt: { type: 'number' },
    answeredAt: { type: 'number' },
  },
  required: ['message', 'session', 'from', 'text', 'status', 'turn', 'answeredWith', 'sentAt'],
};

const MESSAGE_SENT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    status: { type: 'string', enum: ['accepted', 'delivered', 'answered'] },
  },
  required: ['message', 'status'],
};

const SPAWN_OPTION_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    available: { type: 'boolean' },
    values: { type: ['array', 'null'], items: { type: 'string' } },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { value: { type: 'string' }, resolvesTo: { type: ['string', 'null'] } },
        required: ['value', 'resolvesTo'],
      },
    },
    default: { type: ['string', 'null'] },
    backendEffect: { type: ['string', 'null'], enum: ['applied', 'unverified', null] },
    note: { type: ['string', 'null'] },
  },
  required: ['supported', 'available', 'values', 'examples', 'default', 'backendEffect', 'note'],
};

const AGENTS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    daemon: {
      type: 'object',
      properties: {
        hostname: { type: 'string' },
        platform: { type: 'string' },
        arch: { type: 'string' },
        build: { type: 'string' },
      },
      required: ['hostname', 'platform', 'arch', 'build'],
    },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string' },
          installed: { type: 'boolean' },
          capabilities: {
            type: 'object',
            properties: {
              spawn: { type: 'boolean' },
              readTranscript: { type: 'boolean' },
              message: { type: 'boolean' },
              attach: { type: 'boolean' },
              screen: { type: 'boolean' },
              input: { type: 'boolean' },
            },
            required: ['spawn', 'readTranscript', 'message', 'attach', 'screen', 'input'],
          },
          models: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
          spawnOptions: {
            type: 'object',
            properties: { model: SPAWN_OPTION_OUTPUT, effort: SPAWN_OPTION_OUTPUT },
            required: ['model', 'effort'],
          },
        },
        required: ['id', 'label', 'kind', 'installed', 'capabilities', 'models', 'spawnOptions'],
      },
    },
  },
  required: ['daemon', 'agents'],
};

const EVENTS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          at: { type: 'number' },
          session: { type: 'string' },
          name: { type: ['string', 'null'] },
          kind: { type: 'string' },
          detail: { type: ['string', 'null'] },
          message: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['cursor', 'at', 'session', 'name', 'kind', 'detail'],
      },
    },
    cursor: { type: 'string' },
    more: { type: 'boolean' },
  },
  required: ['events', 'cursor', 'more'],
};

interface MCPToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

interface MCPToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;

  // The shape of the tool's structured result, for the tools that declare one.
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: MCPToolAnnotations;

  // What the connected daemon has to announce for the tool to be listed at
  // all, for its output schema to be declared, and for each listed input
  // property to be offered. An older daemon gets the tool without them.
  readonly requires?: {
    readonly tool?: DaemonFeature;
    readonly output?: DaemonFeature;
    readonly inputs?: Readonly<Record<string, DaemonFeature>>;
  };
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
    description: buildSpawnDescriptions(null).tool,
    inputSchema: SPAWN_INPUT,
    requires: { inputs: { model: 'spawn.options', effort: 'spawn.options' } },
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
    name: 'atc_agents_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "List the agents this atc host can run sessions under, plus the host itself (daemon: hostname, platform, arch, build). Each agent has its id (pass it as atc_session_spawn's agent), label, kind (the agent CLI family it runs), installed (whether its binary resolves on this host; a registered agent that is not installed cannot spawn), capabilities (spawn, readTranscript, message, attach, screen, input), models (the model names the config sets for it, or null), and spawnOptions when the daemon supports spawn options. spawnOptions holds model and effort, each with supported (whether atc passes it to the agent CLI), available (whether a spawn on this host can pass it now), values (the accepted set, or null for any alias or model name), examples (each with the provider model it resolves to, when the config maps one), default (the configured value, or null for the CLI's own), backendEffect (applied, or unverified when the backend may ignore it), and a note. atc_session_spawn accepts exactly the available options. It never includes credentials, environment values, or endpoints, and holds nothing about which plans or subscriptions an agent's account has.",
    inputSchema: NO_INPUT,
    outputSchema: AGENTS_OUTPUT,
    requires: { tool: 'agents.list', output: 'spawn.options' },
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
      'Catch up on the fleet: session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-accepted, message-delivered, message-answered), and reports (report) since a cursor, oldest first, each with the session id and name. A message event carries the message id; read the full message with atc_message_get. A report event carries its label. Without a cursor it returns the most recent events. Pass the returned cursor next time; more is true when the page stopped before the newest event, so read again at once. session limits the read to one session. waitMs holds the call open until an event arrives; pass it instead of polling in a tight loop.',
    inputSchema: EVENTS_READ_INPUT,
    outputSchema: EVENTS_OUTPUT,
    requires: { output: 'events.more', inputs: { session: 'events.session' } },
  },
  {
    name: 'atc_session_message',
    annotations: AGENT_FACING,
    scope: 'message',
    description:
      "Send a session a message and get its id back. Follow up with atc_message_get, passing waitMs so each call waits for the next status change instead of polling in a tight loop, until its status is answered; don't read the session's screen or transcript to check on it. The answer is the final output of the session turn that carried the message, and one turn can carry several messages. The message waits in the session inbox until the session takes it, and its status moves accepted, delivered, answered. A message is refused as unsupported when the session's agent has no message tap (capabilities.message is false in atc_agents_list), or when a Claude session reported SessionStart more than 15 seconds ago and no tap has attached since. It is refused as session_dead when the session has no live process and as no_such_session for an unknown id. Otherwise it queues, including while a session restores or after its tap dropped. The message is never typed into the terminal.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_session_list' },
        text: { type: 'string', description: 'The message text' },
        from: {
          type: 'string',
          description:
            'Who the message is from; defaults to the calling session id, or mcp outside a session. Ignored for a remote client, whose messages are always from its own name',
        },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: MESSAGE_SENT_OUTPUT,
  },
  {
    name: 'atc_message_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read one message sent with atc_session_message: its id, session, from, text, status (accepted, delivered, or answered), the answer once answered, turn, answeredWith, and the sentAt, deliveredAt, and answeredAt timestamps. The answer is the final output of the session turn that carried the message, not a reply to that message alone: when one turn carries several messages, each gets the same answer. turn is that turn id, or null when the session reported none, and answeredWith lists the other messages the same turn answered. Pass waitMs to hold the call until the status changes from what it was when you called, up to 30000 ms, instead of polling in a tight loop; an answered message returns at once. Message ids and statuses persist, so after a call ends or times out, call again with the same id.',
    inputSchema: MESSAGE_GET_INPUT,
    outputSchema: MESSAGE_OUTPUT,
    requires: { output: 'message.turn', inputs: { waitMs: 'message.wait' } },
  },
];
