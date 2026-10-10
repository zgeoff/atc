import { z } from 'zod';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import type { GrantScope } from '../shared/grant-scope';
import { buildSpawnDescriptions } from './build-spawn-descriptions';
import { IDEMPOTENCY_KEY_FIELD } from './parse-idempotency-key';
import type { FleetFeature } from './types';

const NO_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(z.strictObject({}));

/**
 * The session id shape MCP tool schemas require: present and described.
 * The daemon's wire request schemas share a defaulted-session shape
 * instead, since they tolerate an absent session by defaulting it to an
 * empty string.
 */
const SESSION_ID_BASE = z.object({
  session: z.string().describe('The atc session id, from atc_sessions_list'),
});

const SESSION_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(SESSION_ID_BASE.strict());
const SPAWN_SCHEMA = REQUEST_PARAM_SCHEMAS['session.spawn'];
const SPAWN_AGENT_DESCRIPTION = buildSpawnDescriptions(null).agent;

// The key as a plain JSON Schema property, for an input schema written out
// by hand.
const { $schema: _, ...IDEMPOTENCY_KEY_INPUT } = z.toJSONSchema(IDEMPOTENCY_KEY_FIELD, {
  io: 'input',
});

// The daemon a call goes to, offered only by a caller that routes across
// named daemons.
const DAEMON_FIELD = z
  .string()
  .optional()
  .describe(
    'The atc daemon to run on, one of the names atc_daemons_list returns. Omit it to use the default daemon. A daemon that is down answers daemon_unavailable; atc never runs the call on another daemon instead.',
  );

const DIRS_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({ daemon: DAEMON_FIELD }),
  { io: 'input' },
);

// The scope a session may touch beyond its own workspace, which atc checks
// entry by entry on the session's host.
const SCOPE_WORKTREE = z.strictObject({ path: z.string() });
const SCOPE_BRANCH = z.strictObject({ name: z.string(), repo: z.string().optional() });
const SCOPE_PULL_REQUEST_NUMBER = z.number().int();

const SCOPE_PULL_REQUEST = z.strictObject({
  number: SCOPE_PULL_REQUEST_NUMBER,
  repo: z.string().optional(),
});

const SCOPE_FIELD = z
  .strictObject({
    worktrees: z
      .array(SCOPE_WORKTREE)
      .optional()
      .describe('Absolute paths of git worktrees on the session host, each its worktree top level'),
    branches: z
      .array(SCOPE_BRANCH)
      .optional()
      .describe(
        "Branches that exist in repo, an absolute repository path on the session host; repo defaults to the session's directory",
      ),
    pullRequests: z
      .array(SCOPE_PULL_REQUEST)
      .optional()
      .describe(
        "GitHub pull requests of repo, as owner/name; repo defaults to the GitHub repository of the workspace's origin",
      ),
  })
  .describe(
    "Worktrees, branches, and pull requests the session may touch beyond its own workspace. atc checks each entry on the session's host, refuses an invalid or unknown entry with scope_invalid naming it, and records the rest in the session's record, which the session reads at $ATC_SESSION_RECORD.",
  );

const SPAWN_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    daemon: DAEMON_FIELD,
    cwd: SPAWN_SCHEMA.shape.cwd.describe(
      "Absolute path of the working directory. Required, except with a git workspace: omit it there and atc picks a new directory under the target user's home, ~/.local/share/atc/workspaces/<repo>-<ref>-<short sha> unless the config sets another root, adding -2, -3, and so on when that directory exists. The session's cwd in the result holds the path it landed in.",
    ),
    name: SPAWN_SCHEMA.shape.name.describe('Session name; defaults to the directory basename'),
    prompt: SPAWN_SCHEMA.shape.prompt.describe('First message for the session'),
    agent: SPAWN_SCHEMA.shape.agent.describe(SPAWN_AGENT_DESCRIPTION),
    model: SPAWN_SCHEMA.shape.model.describe(
      "Model for the new session: an alias or a full model name, at most 200 characters, never starting with '-'. It reaches the agent CLI as its own argument. Refused when the agent takes no model; spawnOptions.model in atc_spawn_options_get holds each agent's support, default, and examples. Omit it to keep the agent's configured default.",
    ),
    effort: SPAWN_SCHEMA.shape.effort.describe(
      "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_spawn_options_get. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
    ),
    target: SPAWN_SCHEMA.shape.target.describe(
      'Execution target for the new session, one of the target ids in atc_spawn_options_get. Omit it to run on the default target (spawnDefaults.target). An unknown or unavailable target is refused; atc never runs the session on another target instead.',
    ),
    workspace: SPAWN_SCHEMA.shape.workspace.describe(
      "Where the session's working directory comes from. Omit it to run the session in cwd as it stands. With it, atc materializes a clean checkout into cwd on the target, which must not exist yet, or for a git source without cwd into a directory atc picks: {kind:'path', path, allowDirty?} checks out the pushed HEAD of a git checkout on the atc host, leaving its uncommitted and untracked changes behind with a warning, or refusing them when allowDirty is 'refuse'; {kind:'git', url, ref or sha, credentialRef?} checks out a branch, tag, or full commit of a repository, with credentialRef {kind:'env', name} naming the atc daemon's environment variable that holds its token. A directory outside git runs in place only on a target on the atc host itself (provider local-pty), with cwd equal to its path. Submodules and Git LFS are refused, and so is a URL that carries a credential.",
    ),
    trustClonedWorkspace: SPAWN_SCHEMA.shape.trustClonedWorkspace.describe(
      "Trust the exact verified clone for this launch. An explicit true or false overrides the configured target trustClonedWorkspace default; omitting both keeps trust off. Requires a workspace source and either stock Claude on the local target, which adds trust for the clone root alone to the user's Claude config, or, on an imp target, a brokered Claude gateway or stock Claude signed in through the broker, each with isolated guest config; other launches are refused. Accepts repository configuration and helpers without changing tool permission mode. Existing guest config is preserved.",
    ),
    scope: SCOPE_FIELD.optional(),
    detached: z
      .boolean()
      .optional()
      .describe(
        'Spawn a top-level session. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, stopped with it.',
      ),
    idempotencyKey: IDEMPOTENCY_KEY_FIELD,
  }),
  { io: 'input' },
);

const SCOPE_ADD_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.extend({ scope: SCOPE_FIELD }).strict(),
  { io: 'input' },
);

const SESSION_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.extend({
    cursor: z
      .string()
      .optional()
      .describe(
        'The cursor a previous atc_transcript_read returned; omit to read from the start of the conversation',
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
    previewOnly: z
      .boolean()
      .optional()
      .describe(
        'true returns each note as its 600-character preview instead of its full text; defaults to false',
      ),
  }),
  { io: 'input' },
);

const MESSAGE_GET_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    message: z.string().describe('The message id atc_message_send returned'),
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
    status: { type: 'string', enum: ['queued', 'delivered', 'answered'] },
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
    status: { type: 'string', enum: ['queued', 'delivered', 'answered'] },
  },
  required: ['message', 'status'],
};

const SPAWN_OPTION_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    supported: {
      type: 'boolean',
      description: 'whether atc passes this option to the agent CLI',
    },
    available: {
      type: 'boolean',
      description: 'whether a spawn on this host can pass the option now',
    },
    values: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'the accepted set; null for any alias or model name',
    },
    examples: {
      type: 'array',
      description: 'example values, each with the provider model it resolves to',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'a value the option takes' },
          resolvesTo: {
            type: ['string', 'null'],
            description: 'the provider model the value resolves to; null when the config maps none',
          },
        },
        required: ['value', 'resolvesTo'],
      },
    },
    default: {
      type: ['string', 'null'],
      description: "the configured value; null for the CLI's own default",
    },
    backendEffect: {
      type: ['string', 'null'],
      enum: ['applied', 'unverified', null],
      description: 'applied, or unverified when the backend may ignore the option',
    },
    note: { type: ['string', 'null'], description: 'a note on the option, or null' },
  },
  required: ['supported', 'available', 'values', 'examples', 'default', 'backendEffect', 'note'],
};

const AGENTS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    daemon: {
      type: 'object',
      description: 'the host the daemon runs on',
      properties: {
        hostname: { type: 'string', description: "the host's name" },
        platform: { type: 'string', description: "the host's operating system" },
        arch: { type: 'string', description: "the host's CPU architecture" },
        build: { type: 'string', description: "the daemon's build" },
      },
      required: ['hostname', 'platform', 'arch', 'build'],
    },
    agents: {
      type: 'array',
      description: 'the registered agents',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "the agent's id; pass it as agent to atc_session_spawn",
          },
          label: { type: 'string', description: "the agent's display name" },
          kind: { type: 'string', description: 'the agent CLI family it runs' },
          installed: {
            type: 'boolean',
            description:
              'whether its binary resolves on this host; a registered agent that is not installed cannot spawn',
          },
          brokerAuth: {
            type: 'boolean',
            description: 'whether a session can sign in through a credential broker',
          },
          brokerRequired: {
            type: 'boolean',
            description: 'whether the agent runs only through a credential broker',
          },
          capabilities: {
            type: 'object',
            description: 'what atc can do with the agent',
            properties: {
              spawn: { type: 'boolean', description: 'atc can start a session of the agent' },
              readTranscript: {
                type: 'boolean',
                description: "atc_transcript_read can read the agent's conversation log",
              },
              message: {
                type: 'boolean',
                description: 'the agent takes messages through atc_message_send',
              },
              attach: { type: 'boolean', description: 'a person can attach to its terminal' },
              screen: { type: 'boolean', description: 'atc_terminal_read can read its screen' },
              input: {
                type: 'boolean',
                description: 'atc_terminal_type can type into its terminal',
              },
            },
            required: ['spawn', 'readTranscript', 'message', 'attach', 'screen', 'input'],
          },
          models: {
            type: ['object', 'null'],
            additionalProperties: { type: 'string' },
            description: 'the model names the config sets for the agent; null when it sets none',
          },
          spawnOptions: {
            type: 'object',
            description:
              'the model and effort options a spawn takes, present when the daemon supports them',
            properties: {
              model: SPAWN_OPTION_OUTPUT,
              effort: SPAWN_OPTION_OUTPUT,
            },
            required: ['model', 'effort'],
          },
        },
        required: ['id', 'label', 'kind', 'installed', 'capabilities', 'models', 'spawnOptions'],
      },
    },
    targets: {
      type: 'array',
      description: 'the execution targets, present when the daemon supports targets',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "the target's id; pass it as target to atc_session_spawn",
          },
          provider: { type: 'string', description: "the target's provider kind" },
          identity: { type: 'string', description: "the target's identity" },
          available: {
            type: 'boolean',
            description: 'whether a spawn can use the target now',
          },
          default: { type: 'boolean', description: 'whether a spawn without target runs here' },
          capabilities: {
            type: 'object',
            description: 'what the target can do, by capability name',
            additionalProperties: { type: 'boolean' },
          },
          brokerAuth: {
            type: 'boolean',
            description: 'whether sessions on the target sign in through a credential broker',
          },
        },
        required: ['id', 'provider', 'identity', 'available', 'default', 'capabilities'],
      },
    },
    spawnDefaults: {
      type: 'object',
      description: 'what a spawn without agent or target runs with',
      properties: {
        agent: { type: 'string', description: 'the agent id a spawn without agent runs' },
        target: {
          type: ['string', 'null'],
          description:
            'the target id a spawn without target runs on; a null target means a spawn without target is refused',
        },
      },
      required: ['agent', 'target'],
    },
    configRevision: {
      type: 'string',
      description: 'a digest that changes whenever the target config does',
    },
    targetErrors: {
      type: 'array',
      description:
        'config problems that leave a target, or every target, unusable; scope config, with problem config_malformed or config_unreadable, means the config file exists but cannot be parsed or read, and refuses every spawn, local included',
      items: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['config', 'targets', 'target', 'defaultTarget'],
            description: 'what the problem affects',
          },
          target: { type: 'string', description: 'the target the problem is about, when one' },
          problem: { type: 'string', description: 'the problem code, such as config_malformed' },
          path: { type: 'string', description: 'the config path the problem is about' },
          detail: { type: 'string', description: 'the problem in words' },
        },
        required: ['scope', 'problem'],
      },
    },
    sources: {
      type: 'array',
      description:
        "the sources the TUI's spawn picker offers for choosing a directory or repository",
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: "the source's id" },
          label: { type: 'string', description: "the source's display name" },
          kind: {
            type: 'string',
            description: 'path for a directory on the host, git for a repository URL',
          },
        },
        required: ['id', 'label', 'kind'],
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
          kind: {
            type: 'string',
            description: 'the event kind; the tool description lists them',
          },
          detail: { type: ['string', 'null'] },
          message: { type: 'string' },
          label: { type: 'string' },
          text: { type: 'string' },
          complete: {
            type: 'boolean',
            description: "false: atc kept only this note's preview, and text holds it",
          },
          textError: {
            type: 'string',
            description: "the note's text did not load within 10 seconds; detail holds the preview",
          },
        },
        required: ['cursor', 'at', 'session', 'name', 'kind', 'detail'],
      },
    },
    cursor: { type: 'string' },
    more: { type: 'boolean' },
    unavailable: {
      type: 'array',
      items: { type: 'string' },
      description:
        'under the gateway, daemons that did not answer; each keeps its place in the cursor',
    },
    started: {
      type: 'array',
      items: { type: 'string' },
      description:
        'under the gateway, daemons that joined the cursor on this call, read from their latest events',
    },
    truncated: {
      type: 'array',
      items: { type: 'string' },
      description: 'under the gateway, those of the started daemons with older events left unread',
    },
  },
  required: ['events', 'cursor', 'more'],
};

const TERMINAL_TYPE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: { written: { type: 'boolean' } },
  required: ['written'],
};

const SESSION_STOP_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    stopped: {
      type: 'boolean',
      description:
        'true when the call stopped a live process; false when the session had already exited',
    },
  },
  required: ['stopped'],
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
  // `outputUnless` leaves the output schema out when the caller announces
  // that feature, for a tool whose result takes another shape there.
  readonly requires?: {
    readonly tool?: FleetFeature;
    readonly output?: FleetFeature;
    readonly outputUnless?: FleetFeature;
    readonly inputs?: Readonly<Record<string, FleetFeature>>;
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
    name: 'atc_sessions_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "List the sessions atc hosts, or every daemon's sessions under the gateway, with each one's id, name, directory, agent, state, unread and pinned flags. state is running (the agent is working), needs_you (the agent asked for a person, such as a permission prompt), done (the turn ended; it waits for the next prompt) or exited (no live process). For one session's pending prompt and last reply, use atc_session_get. Under the gateway, daemons holds each daemon's state, so a daemon that is down never reads as one with no sessions.",
    inputSchema: NO_INPUT,
  },
  {
    name: 'atc_session_spawn',
    annotations: AGENT_FACING,
    scope: 'spawn',
    description: buildSpawnDescriptions(null).tool,
    inputSchema: SPAWN_INPUT,
    requires: {
      inputs: {
        daemon: 'fleet.daemons',
        model: 'spawn.options',
        effort: 'spawn.options',
        idempotencyKey: 'spawn.idempotency',
        target: 'spawn.target',
        workspace: 'spawn.workspace',
        trustClonedWorkspace: 'spawn.workspace.trust',
        scope: 'session.record',
      },
    },
  },
  {
    name: 'atc_terminal_type',
    annotations: AGENT_FACING_DESTRUCTIVE,
    scope: 'spawn',
    description:
      "Type a line into a session's terminal and press Enter, as a person at the keyboard would. This tool cannot answer a menu: on a permission prompt, the folder-trust dialog or any other choice list, the text is dropped and Enter picks the highlighted option. A person answers those in the TUI. It is refused with permission_pending while the agent waits on a permission prompt. Use it for a plain-text prompt, or for an agent that takes no messages. When the agent takes messages (capabilities.message true in atc_spawn_options_get), use atc_message_send instead: it is tracked and returns the answer. Returns { written: true } once the line reaches the terminal; that does not show the agent took it, so check with atc_terminal_read or atc_events_read. A long line arrives as a paste, so the agent's input box and atc_terminal_read can show a placeholder such as [Pasted text #1] instead of the text.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: { type: 'string', description: 'The line to type; atc presses Enter after it' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: TERMINAL_TYPE_OUTPUT,
  },
  {
    name: 'atc_terminal_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read a session's terminal screen as plain text, as it is now. Use it to see a prompt, a menu or an error the agent printed. A stopped session keeps its last screen until it is forgotten; after a daemon restart, or for a headless session, there is no screen and the call returns session_dead.",
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_scope_add',
    annotations: ADDITIVE,
    scope: 'spawn',
    description:
      "Add worktrees, branches or pull requests to the scope a session's record holds. atc checks each entry on the session's host and refuses an invalid one with scope_invalid. Entries already held change nothing, and nothing is ever removed. A session cannot add to its own scope or its parent's. Returns the record as it stands after.",
    inputSchema: SCOPE_ADD_INPUT,
    requires: { tool: 'session.record' },
  },
  {
    name: 'atc_session_update',
    annotations: ADDITIVE,
    scope: 'message',
    description:
      'Rename or pin a session. A name set here replaces auto-summaries, but a name the agent set with /rename wins: the rename is skipped and the call still returns updated. A pinned session leads every list and cannot be forgotten. A sub-session pins with its parent, so pin the parent.',
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
    name: 'atc_session_stop',
    annotations: DESTRUCTIVE,
    scope: 'kill',
    description:
      "Stop a session's agent process. Its live sub-sessions stop with it. On an imp the host is suspended, not destroyed, and the call fails with host_leased while something keeps the host awake. The session stays in the list as exited; atc_session_forget removes it. Stopping an exited session changes nothing.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_STOP_OUTPUT,
  },
  {
    name: 'atc_session_forget',
    annotations: DESTRUCTIVE,
    scope: 'kill',
    description:
      "Remove a session from the list for good. On an imp target this destroys the host and everything on it, so it takes two calls: the first changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token, returns { forgotten: true, destroyed: true }. A sub-session that shares its parent's imp host needs the token too but keeps the host (destroyed: false). On any other target one call returns { forgotten: true, destroyed: false }. Refused: a live session unless stop is true, and a pinned session or a sub-session of one (unpin it with atc_session_update first). Live sub-sessions on a host that survives move to the top level.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        confirmToken: {
          type: 'string',
          minLength: 1,
          description: 'The token an earlier call on the same session returned',
        },
        stop: {
          type: 'boolean',
          description: 'Stop the session when it is live; omit or false refuses a live session',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    requires: { tool: 'session.forget' },
  },
  {
    name: 'atc_session_mark_read',
    annotations: ADDITIVE,
    scope: 'message',
    description: "Clear a session's unread flag. Nothing else changes.",
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_recent_dirs_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "List the directories earlier spawns used, newest first, as candidates for atc_session_spawn's cwd. Under the gateway, daemon picks whose history to read.",
    inputSchema: DIRS_INPUT,
    requires: { inputs: { daemon: 'fleet.daemons' } },
  },
  {
    name: 'atc_daemons_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "List the daemons this gateway routes to: name, state (up, down, unauthorized, changed or outdated), build and features, plus defaultDaemon, where a spawn without daemon goes. Session and message ids start with the daemon's name and incarnation, so an id shows which daemon holds it.",
    inputSchema: NO_INPUT,
    requires: { tool: 'fleet.daemons' },
  },
  {
    name: 'atc_spawn_options_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read what atc_session_spawn accepts on this daemon: each agent (pass its id as agent) with whether it is installed, its capabilities, and the model and effort values it takes; each execution target (pass its id as target) with whether it is available; and spawnDefaults. A spawn that would fail says so in advance: an agent with installed false, a target with available false, or an entry in targetErrors, with their meanings in the output schema. Under the gateway it returns one such object per daemon. It never holds credentials, environment values or endpoints.',
    inputSchema: NO_INPUT,
    outputSchema: AGENTS_OUTPUT,
    requires: { tool: 'agents.list', output: 'spawn.options', outputUnless: 'fleet.daemons' },
  },
  {
    name: 'atc_session_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read one session: its entry as atc_sessions_list shows it, the prompt it was spawned with, when it last reported activity, pending (the agent\'s notification text while it is needs_you, such as "Claude needs your permission"; never a menu\'s options), result (the final reply of its latest finished turn) and sessionRecord (the scope atc recorded for it). A permission prompt or other menu cannot be answered through atc; a person answers it in the TUI.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_transcript_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read a session's conversation log a page at a time, oldest first: user and assistant messages, with tool uses summarised. Pass the returned cursor to continue; more is true when the page stopped before the end. Claude and Claude-compatible agents only; other agents return unsupported.",
    inputSchema: SESSION_READ_INPUT,
  },
  {
    name: 'atc_events_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read the fleet's event feed: the one call to catch up on session state changes, the notes sessions send, and the progress of messages you sent, oldest first. It holds session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-queued, message-delivered, message-answered, with the message id) and notes (note, with its label and full text). Pass the returned cursor on the next call; more true means the page stopped early, so read again at once. Without a cursor it returns the latest events, and more is false even when older ones exist. waitMs holds the call until an event arrives, up to 30000; use it instead of polling. session limits the read to one session; previewOnly true returns 600-character note previews. A partial read says so: complete false or textError on a note, and, under the gateway, unavailable, started or truncated, with their meanings in the output schema.",
    inputSchema: EVENTS_READ_INPUT,
    outputSchema: EVENTS_OUTPUT,
    requires: {
      output: 'events.more',
      inputs: { session: 'events.session' },
    },
  },
  {
    name: 'atc_message_send',
    annotations: AGENT_FACING,
    scope: 'message',
    description:
      "Send a message to a session's agent and get its id back. The message goes into the agent's conversation, never into the terminal, and the agent's answer comes back on the message: follow with atc_message_get and waitMs until status is answered. status is queued (waiting in atc's inbox), delivered (handed to the session, not yet confirmed as seen by the model) or answered. The answer is the final reply of the turn that carried the message; messages in one turn share it, and answeredWith lists them. A message whose turn is interrupted stays delivered. Refused: unsupported when the agent takes no messages (capabilities.message false in atc_spawn_options_get) or its message bridge never attached; session_dead when the session has no live process, including one still booting after a daemon restart; no_such_session for an unknown id. A retry with the same idempotencyKey and text returns the same message.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: { type: 'string', description: 'The message text' },
        from: {
          type: 'string',
          description:
            'Who the message is from; defaults to the calling session id, or mcp outside a session. Ignored for a remote client, whose messages are always from its own name',
        },
        idempotencyKey: IDEMPOTENCY_KEY_INPUT,
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: MESSAGE_SENT_OUTPUT,
    requires: { inputs: { idempotencyKey: 'message.idempotency' } },
  },
  {
    name: 'atc_message_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read one message sent with atc_message_send: status (queued, delivered or answered), the answer once answered, turn, answeredWith and timestamps. The answer is the final reply of the turn that carried the message; messages in one turn share it, and answeredWith lists them. Pass waitMs, up to 30000, to hold the call until the status changes; an answered message returns at once. Ids and statuses persist, so call again after a timeout.',
    inputSchema: MESSAGE_GET_INPUT,
    outputSchema: MESSAGE_OUTPUT,
    requires: { output: 'message.turn', inputs: { waitMs: 'message.wait' } },
  },
];
