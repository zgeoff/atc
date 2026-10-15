import { REQUEST_PARAM_SCHEMAS } from '@atc/protocol';
import { SESSION_ENV_NAMES } from '@atc/protocol/session';
import { z } from 'zod';
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
    `Worktrees, branches, and pull requests the session may touch beyond its own workspace, at most 64 of each. atc checks worktrees and branches on the session's host and pull requests with gh on the atc daemon's host. The first invalid or unknown entry refuses the whole scope with scope_invalid naming it, and atc records none of it. A valid scope goes into the session's record, which the session reads at $${SESSION_ENV_NAMES.sessionRecord}.`,
  );

const SPAWN_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    daemon: DAEMON_FIELD,
    cwd: SPAWN_SCHEMA.shape.cwd.describe(
      "Absolute path of the working directory. Required, except with a git workspace: omit it there and atc picks a new directory under the target user's home, ~/.local/share/atc/workspaces/<repo>-<ref>-<short sha> unless the config sets another root, adding -2, -3, and so on when that directory exists. The session's cwd in the result holds the path it landed in.",
    ),
    name: SPAWN_SCHEMA.shape.name.describe(
      'Session name; defaults to the basename of the working directory, without the -2, -3 suffix of a directory atc picked',
    ),
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
      "Trust the exact verified clone for this launch. An explicit true or false overrides the configured target trustClonedWorkspace default; omitting both keeps trust off. Requires a workspace source and either stock Claude on the local target, which adds trust for the clone root alone to the user's Claude config, or, on an imp target, an agent signed in through the broker whose isolated guest config takes trust, such as a brokered Claude gateway or stock Claude; other launches are refused, and the refusal lists the ones that work. Accepts repository configuration and helpers without changing tool permission mode. Existing guest config is preserved.",
    ),
    scope: SCOPE_FIELD.optional(),
    detached: z
      .boolean()
      .optional()
      .describe(
        'Spawn a top-level session with no parent, whose pin and forget stand on their own. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, stopped with it, and forgettable while it is pinned only by a call from inside it. atc_session_update with parent null detaches a sub-session later.',
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
        "An atc session id; limits the read to that session's events. On one daemon a cursor stays valid across filtered and unfiltered reads; under the gateway a cursor holds only for the session filter it was read under, and another filter refuses it with bad_args",
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
        'true returns each note and each answer as its 600-character preview instead of its full text; defaults to false',
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
    message: { type: 'string', description: 'the message id' },
    session: { type: 'string', description: 'the atc session id the message went to' },
    from: {
      type: 'string',
      description:
        "The sender's name, the same as sender.name; on a message stored before atc labelled senders, the name its sender gave",
    },
    sender: {
      type: 'object',
      description:
        "Who sent the message, as atc labelled it from the caller; no caller sets it. kind is connector (a remote client, its OAuth client id in client and its client name in name), session (an atc session, its id in session and the name it had when it sent in name), or owner (the user's own atc command line, name owner); a later daemon may add a kind. Absent on a message stored before atc labelled senders",
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
        client: { type: 'string' },
        session: { type: 'string' },
      },
    },
    text: { type: 'string', description: 'the text that was sent' },
    status: {
      type: 'string',
      description:
        'queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value',
    },
    answer: {
      type: 'string',
      description:
        'the text the session sent with the answer tool or, if none, the final reply of the turn that answered the message, cut at 64 KiB; present only on an answered message',
    },
    turn: {
      type: ['string', 'null'],
      description:
        "the id of the agent's turn whose final reply answered the message or that ended without an answer; null for an answer sent with the answer tool, and while atc holds none",
    },
    answeredWith: {
      type: 'array',
      items: { type: 'string' },
      description:
        'the ids of the other messages to the same session that the same turn answered and the caller can see; this message is never among them',
    },
    sentAt: { type: 'number', description: 'when atc queued the message, in epoch milliseconds' },
    deliveredAt: {
      type: 'number',
      description: 'when atc handed the message to the session, in epoch milliseconds',
    },
    answeredAt: {
      type: 'number',
      description: 'when atc stored the answer, in epoch milliseconds',
    },
    unansweredAt: {
      type: 'number',
      description: 'When atc marked the message unanswered; present only on an unanswered message',
    },
    unansweredReason: {
      type: 'string',
      description:
        'Why the turn ended without an answer: interrupted (a person stopped the turn), error (the turn failed), refusal (the model declined), not_started (the prompt never started a turn), or session_ended (the process of the session ended before the turn did); present only on an unanswered message',
    },
  },
  required: ['message', 'session', 'from', 'text', 'status', 'turn', 'answeredWith', 'sentAt'],
};

const MESSAGE_SENT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'the message id, for atc_message_get' },
    status: {
      type: 'string',
      description:
        'queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value',
    },
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
      description:
        'applied, or unverified when the backend may ignore the option; null when the agent takes no such option; a later daemon may add a value',
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
            description:
              "whether the daemon has a provider of the target's kind; it does not show the target's host is up",
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
      description:
        'a digest of the target config the daemon read at start; it changes only when the daemon restarts with another config',
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
            description:
              'what the problem affects: config, targets, target or defaultTarget; a later daemon may add a value',
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
          cursor: {
            type: 'string',
            description: 'the cursor at this event; pass it to read on from after the event',
          },
          at: { type: 'number', description: 'when the event happened, in epoch milliseconds' },
          session: { type: 'string', description: 'the atc session id the event belongs to' },
          name: {
            type: ['string', 'null'],
            description: "the session's current name; null when atc no longer lists the session",
          },
          kind: {
            type: 'string',
            description: 'the event kind; the tool description lists them',
          },
          detail: {
            type: ['string', 'null'],
            description:
              "the event's detail, at most 600 characters; for a note or a message-answered event, the preview of its text or answer; null when the event has none",
          },
          message: {
            type: 'string',
            description: 'on a message or notice event, the message id, for atc_message_get',
          },
          label: { type: 'string', description: "on a note, the note's label" },
          text: {
            type: 'string',
            description:
              'on a note, the text atc stored; on a message-answered event, the answer atc stored; each cut at 64 KiB; absent with previewOnly or textError',
          },
          complete: {
            type: 'boolean',
            description:
              'false: atc kept only the preview of this note or answer, and text holds it. A text cut at 64 KiB reads true',
          },
          textError: {
            type: 'string',
            description:
              'the text of the note or answer did not load: its read failed, or the 10 seconds every text read on the page shares ran out; detail holds the preview',
          },
        },
        required: ['cursor', 'at', 'session', 'name', 'kind', 'detail'],
      },
    },
    cursor: {
      type: 'string',
      description: 'the cursor after the last event on the page; pass it on the next call',
    },
    more: {
      type: 'boolean',
      description:
        'true when events after this page wait to be read, so read again at once; a read without a cursor never counts the older events it skipped',
    },
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
  properties: {
    written: {
      type: 'boolean',
      description:
        'true once the line reached the terminal, or started a headless turn; it does not show the agent took it',
    },
  },
  required: ['written'],
};

const SESSION_ADOPT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    adopted: {
      type: 'boolean',
      description:
        "true once atc started or attached the session's terminal; it does not show the agent booted",
    },
  },
  required: ['adopted'],
};

const SESSION_AUTH_REBIND_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    revision: {
      type: 'number',
      description: "the revision the host's runtime auth binding holds after the rebind",
    },
    restartPending: {
      type: 'array',
      items: { type: 'string' },
      description:
        "the ids of the sessions on the host whose harness launched under an older revision and keeps that revision's settings until its next launch; empty when none",
    },
  },
  required: ['revision', 'restartPending'],
};

// A menu as atc_terminal_choose returns it, and the result of a read or a
// choice on one.
const MENU_OUTPUT: Readonly<Record<string, unknown>> = {
  type: ['object', 'null'],
  description:
    'The menu the screen shows, or null when it shows none: after a choice, the menu once the screen settles',
  properties: {
    text: { type: 'string', description: "The menu's lines above its options" },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'number', description: 'The number a choice gives, counted from 1' },
          label: { type: 'string', description: 'The text a choice gives as label' },
          checked: {
            type: ['boolean', 'null'],
            description: "Whether the option's box is ticked; null for an option with no box",
          },
          highlighted: { type: 'boolean', description: 'Whether the cursor is on the option' },
        },
        required: ['option', 'label', 'checked', 'highlighted'],
      },
    },
    menuToken: {
      type: 'string',
      description:
        'The token a choice on this menu gives; it changes with the text, a label or a box, and not with the cursor',
    },
  },
  required: ['text', 'options', 'menuToken'],
};

const TERMINAL_CHOOSE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    pressed: {
      type: 'string',
      description:
        'After a choice, the key atc pressed last: enter or escape. Absent when the call only read the menu',
    },
    menu: MENU_OUTPUT,
  },
  required: ['menu'],
};

// A session's entry as the session tools return it. Only the fields every
// daemon has sent are required, so an older daemon's entry still validates.
const SESSION_ENTRY_PROPERTIES: Readonly<Record<string, unknown>> = {
  id: {
    type: 'string',
    description: "the atc session id; under the gateway it starts with the daemon's name",
  },
  name: { type: 'string', description: "the session's display name" },
  cwd: { type: 'string', description: "the session's working directory on its host" },
  agent: { type: 'string', description: 'the agent id the session runs' },
  state: {
    type: 'string',
    description:
      'running, needs_you, done or exited; the atc_sessions_list description holds their meanings, and a later daemon may add a value',
  },
  unread: { type: 'boolean', description: 'whether the session has news no one has read' },
  pinned: { type: 'boolean', description: 'whether the session carries a pin of its own' },
  alive: { type: 'boolean', description: 'whether atc holds a live process for the session' },
  parent: {
    type: 'string',
    description:
      'the id of the session this one is a sub-session of; absent on a top-level session',
  },
  kind: {
    type: 'string',
    description: 'pty for a terminal session, headless for a headless one',
  },
  lastMsg: {
    type: 'string',
    description: "atc's one-line summary of the session's latest state",
  },
  createdAt: {
    type: 'number',
    description: 'when atc created the session, in epoch milliseconds',
  },
  model: {
    type: 'string',
    description: "the model the spawn asked for; absent when the agent's default runs",
  },
  workspace: {
    type: 'object',
    description:
      'the repository and commit atc checked out for the session; absent without a workspace source',
  },
  locator: { type: 'object', description: 'the daemon and target the session runs on' },
  lifecycle: {
    type: 'object',
    description: "the wanted and actual state of the session's host, harness and attachment",
  },
};

const SESSION_ENTRY: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: SESSION_ENTRY_PROPERTIES,
  required: ['id', 'name', 'cwd', 'agent', 'state'],
};

const SESSIONS_LIST_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      description: 'the sessions, sub-sessions included, in the order atc holds them',
      items: SESSION_ENTRY,
    },
    daemons: {
      type: 'array',
      description: "under the gateway, each daemon's state",
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "the daemon's name" },
          state: {
            type: 'string',
            description:
              'up, down, unauthorized, changed, outdated (older than this gateway) or refused (it answered with an error); a later daemon may add a value',
          },
        },
        required: ['name', 'state'],
      },
    },
  },
  required: ['sessions'],
};

const SPAWN_OUTPUT: Readonly<Record<string, unknown>> = {
  ...SESSION_ENTRY,
  properties: {
    ...SESSION_ENTRY_PROPERTIES,
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'what the workspace left behind, such as uncommitted changes; absent when there is none, and on a retry with the same idempotencyKey',
    },
  },
};

// A session record as atc publishes it to the session.
const SESSION_RECORD: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    session: { type: 'string', description: 'the atc session id the record belongs to' },
    target: { type: 'string', description: 'the execution target the session runs on' },
    revision: {
      type: 'number',
      description: 'counts from 1 and grows with each change to the record',
    },
    updatedAt: { type: 'string', description: 'when the record last changed, in ISO 8601' },
    scope: {
      type: 'object',
      description:
        "the session's workspace and the worktrees, branches and pull requests it may touch beyond it",
    },
  },
};

const SCOPE_ADD_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    record: { ...SESSION_RECORD, description: "the session's record as it stands after the call" },
  },
  required: ['record'],
};

const SESSION_GET_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    session: { ...SESSION_ENTRY, description: 'the entry atc_sessions_list shows' },
    prompt: {
      type: ['string', 'null'],
      description: 'the prompt the session was spawned with; null without one',
    },
    lastActivityAt: {
      type: 'number',
      description:
        'when atc last recorded an event for the session, else when it was created, in epoch milliseconds',
    },
    pending: {
      type: ['object', 'null'],
      description:
        'while the session is needs_you, { message } with the agent\'s notification text, such as "Claude needs your permission"; never a menu\'s options; else null',
      properties: { message: { type: 'string' } },
    },
    result: {
      type: ['string', 'null'],
      description: 'the final reply of the latest finished turn; null before one',
    },
    sessionRecord: {
      ...SESSION_RECORD,
      type: ['object', 'null'],
      description: 'the scope atc recorded for the session; null when it holds none',
    },
  },
  required: ['session'],
};

const DAEMONS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    daemons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "the daemon's name; pass it as daemon" },
          state: {
            type: 'string',
            description:
              'up, down, unauthorized or changed (another daemon answers at its address); a later gateway may add a value',
          },
          build: {
            type: ['string', 'null'],
            description: "the daemon's build; null unless the daemon is up",
          },
          daemonID: {
            type: 'string',
            description: 'the daemon identity the gateway expects at that address',
          },
          features: {
            type: 'array',
            items: { type: 'string' },
            description: 'the features the daemon announced; empty unless the daemon is up',
          },
        },
        required: ['name', 'state'],
      },
    },
    defaultDaemon: {
      type: 'string',
      description: 'the daemon a call without daemon goes to',
    },
  },
  required: ['daemons', 'defaultDaemon'],
};

const DIRS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    dirs: {
      type: 'array',
      items: { type: 'string' },
      description: 'the directories, newest first, each a path on the host the spawn ran on',
    },
  },
  required: ['dirs'],
};

const TRANSCRIPT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      description: 'the messages on this page, oldest first',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'user or assistant' },
          text: { type: 'string', description: "the message's text" },
          tools: {
            type: 'array',
            description:
              'the tool uses in the message, each with its name and a summary of its input',
          },
          at: {
            type: ['number', 'null'],
            description:
              'when the message was written, in epoch milliseconds; null when the log holds no time',
          },
        },
      },
    },
    cursor: {
      type: 'string',
      description: 'the cursor after this page; pass it on the next call',
    },
    more: {
      type: 'boolean',
      description:
        'true when the page stopped at limit or at its size cap, even when the log ends there; false at the end of the log',
    },
  },
  required: ['rows', 'cursor'],
};

const SESSION_STOP_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    stopped: {
      type: 'boolean',
      description:
        'true when the call stopped a live process, or put it to sleep inside a suspended imp host; false when the session had already exited',
    },
  },
  required: ['stopped'],
};

// A forget's first call on an imp target returns the token pair; the call
// that forgets returns the outcome pair.
const SESSION_FORGET_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    confirmToken: {
      type: 'string',
      description:
        'on the first call on an imp target, the token the second call passes; the call forgot nothing',
    },
    expiresAt: {
      type: 'number',
      description: "when confirmToken stops working, in epoch milliseconds on the daemon's clock",
    },
    forgotten: { type: 'boolean', description: 'true once atc removed the session from the list' },
    destroyed: {
      type: 'boolean',
      description: 'true when the forget also destroyed the imp host the session owned',
    },
  },
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
      "List the sessions atc hosts, or every daemon's sessions under the gateway, with each one's id, name, directory, agent, state, unread and pinned flags, and the parent of each sub-session. For one session's pending prompt and last reply, use atc_session_get. state is running (the agent is working), needs_you (the agent asked for a person, such as a permission prompt), done (the turn ended; it waits for the next prompt) or exited (no live process: it ended, or it sleeps inside a suspended imp host). The list keeps the order atc holds the sessions in and does not put pinned sessions first. A remote client sees only the sessions whose whole tree it reaches. Under the gateway, daemons holds each daemon's state, so a daemon that is down never reads as one with no sessions.",
    inputSchema: NO_INPUT,
    outputSchema: SESSIONS_LIST_OUTPUT,
  },
  {
    name: 'atc_session_spawn',
    annotations: AGENT_FACING,
    scope: 'spawn',
    description: buildSpawnDescriptions(null).tool,
    inputSchema: SPAWN_INPUT,
    outputSchema: SPAWN_OUTPUT,
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
      "Type a line into a session's terminal and press Enter, as a person at the keyboard would. This tool cannot answer a menu: on a permission prompt, the folder-trust dialog or any other choice list, the text is dropped and Enter picks the highlighted option. atc_terminal_choose answers a Claude Code menu, and a person answers any other in the TUI. Only a Claude or Claude-compatible session refuses the line with permission_pending while a permission prompt is open; atc sees no permission prompt of any other agent, and never sees the folder-trust dialog. Use it for a plain-text prompt, or for an agent that takes no messages. When the agent takes messages (capabilities.message true in atc_spawn_options_get), use atc_message_send instead: atc tracks the message, stores the answer, and puts the outcome into a sending session's conversation as an <atc-answer> notice. Returns { written: true } once the line reaches the terminal; that does not show the agent took it, so check with atc_terminal_read or atc_events_read. On a headless session the line starts a headless turn as its prompt and returns the same result; a headless session whose turn still runs refuses it with too_slow. A session with no terminal refuses it with session_dead. The text goes in as one paste, newlines included, whenever the agent's terminal takes pastes, so the agent's input box and atc_terminal_read can show a placeholder such as [Pasted text #1] instead of the text. Empty text presses Enter alone, which submits what the input box already holds. A retry types the line again.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: {
          type: 'string',
          description:
            'The line to type; atc presses Enter after it. Empty text presses Enter alone',
        },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: TERMINAL_TYPE_OUTPUT,
  },
  {
    name: 'atc_terminal_choose',
    annotations: AGENT_FACING_DESTRUCTIVE,
    scope: 'spawn',
    description:
      "Read or answer the menu a session's agent waits on in its terminal, such as a permission prompt, the folder-trust dialog or the new MCP servers list. For a plain-text prompt, use atc_terminal_type. Called with session alone, it returns { menu }: the menu's text, its options with their numbers, labels, ticked boxes and cursor, and menuToken; menu is null when the screen shows no menu. A list longer than the screen, such as a long new MCP servers list, reads whole: atc waits until the agent has printed nothing, moves the cursor through the list with arrow keys, puts it back on the option it was on, and numbers every option by its place in the whole list, so a choice can pick an option the screen does not show. A menu that fits on the screen, or a list atc has read whole before, takes no key, except a list that fills Claude Code's list window with the cursor on its last row, where the screen cannot show whether more options follow; a read never presses Enter or Escape. To pick an option, call again with its option number, its label as read, and menuToken: atc checks all three against the screen before it presses a key, waits until the agent has printed nothing for 4 seconds, or 10 seconds at most, since Claude Code refuses Enter on a menu that has just opened and then moves its cursor back, moves the cursor one arrow key at a time, and presses Enter only once the cursor is on that option. Enter on an option with a box ticks or clears that box and keeps the menu open; pick the menu's own item, such as Enable selected, to confirm it. key escape with menuToken presses Escape on that menu instead: it dismisses the menu, rejects every server on the new MCP servers list, and exits the agent on the folder-trust dialog. A choice returns { pressed, menu }: the key atc pressed last and the menu the screen shows once it settles, or null. The same menu with the cursor on the option means the agent ignored the key, or opened a new menu that reads the same; check atc_events_read before you call again with its menuToken. A refusal presses nothing that picks an option, though menu_changed and menu_busy can come after arrow keys moved the cursor: menu_changed when the screen shows another menu or none, menu_label_mismatch when the menu has no such option or its label differs, and menu_busy when the cursor did not reach the option. A read of a long list can be refused with menu_changed or menu_busy the same way, after arrow keys moved its cursor, and with menu_busy on a terminal too short to show two rows of the list. After any refusal, read the menu again for its state and menuToken. session_dead refuses a session with no screen. menuToken matches any menu with the same text, labels and boxes, so a retry after a choice that went through answers the next menu when it reads the same. It reads only Claude Code's menus, and refuses other agents with unsupported. In a menu without numbers, an option whose label wraps onto a second line reads as two options.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        menuToken: {
          type: 'string',
          description:
            'The menuToken of the menu this call answers, from a call with session alone; omit to only read the menu',
        },
        option: {
          type: 'number',
          description:
            'The number of the option to pick, a whole number counted from 1; give label with it',
        },
        label: {
          type: 'string',
          description: 'The label of that option as the menu showed it',
        },
        key: {
          type: 'string',
          enum: ['escape'],
          description: 'escape presses Escape on the menu instead of picking an option',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: TERMINAL_CHOOSE_OUTPUT,
    requires: { tool: 'session.menu' },
  },
  {
    name: 'atc_terminal_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read a session's terminal screen as plain text, as it is now. Use it to see a prompt, a menu or an error the agent printed; atc_terminal_choose reads a Claude Code menu as numbered options and answers it. atc holds screens in memory only: a stopped session keeps its last screen until it is forgotten or the daemon restarts, and a session restored after a restart starts from an empty screen. A session with no screen, such as one spawned headless or one still exited after a restart, refuses the read with session_dead. A session moved from its terminal to a headless run returns its last terminal screen, which no longer changes.",
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_scope_add',
    annotations: ADDITIVE,
    scope: 'spawn',
    description:
      "Add worktrees, branches or pull requests to the scope a session's record holds. Returns { record }, the record as it stands after; a call that adds nothing returns it unchanged. atc checks every entry, held ones included, as the scope field states, and the first invalid one refuses the whole call with scope_invalid. Nothing is ever removed. A session on a sleeping imp is refused with host_unavailable. Through atc mcp from inside a session, a session cannot add to its own scope or its parent's; a call through atc mcp --http or the gateway carries no caller session, so atc does not check it.",
    inputSchema: SCOPE_ADD_INPUT,
    outputSchema: SCOPE_ADD_OUTPUT,
    requires: { tool: 'session.record' },
  },
  {
    name: 'atc_session_update',
    annotations: ADDITIVE,
    scope: 'message',
    description:
      "Rename, pin, or detach a session. A name has three sources, strongest first: the agent's own /rename, a name given at spawn or set here, and an auto-summary. A name set here replaces any name except one the agent set: then the call keeps the agent's name and returns text that starts \"updated, not renamed\" and states why. Otherwise it returns the text updated whenever the session exists, a call that changes nothing included, so read the session with atc_session_get to see the change. A pinned session cannot be forgotten and leads the TUI's list; atc_sessions_list keeps creation order. A sub-session follows its parent: it pins with the parent, so while the parent is pinned only a call from inside the parent can forget it; it stops when its live parent stops, and a remote client reaches it only when the client reaches the parent and every sub-session of it. A pin set on a sub-session itself stops every caller from forgetting it, its parent included, and keeps it listed as a top-level session when its parent is forgotten. parent null detaches a sub-session: it becomes top-level, so its own pin and forget apply and the former parent keeps its pin. Detaching a top-level session changes nothing. A session cannot move under another parent. A detach or a pin of a sub-session that runs in its parent's imp is refused with bad_args, since that imp sleeps and is destroyed with its parent, and nothing else in that call applies, a rename included.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        name: { type: 'string', description: 'New display name; omit to keep' },
        pinned: { type: 'boolean', description: 'Pin or unpin; omit to keep' },
        parent: {
          type: 'null',
          description:
            'null detaches the session from its parent and makes it top-level; omit to keep. No other value is taken.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    requires: {
      inputs: { parent: 'session.update.parent', name: 'session.update.renameSkipped' },
    },
  },
  {
    name: 'atc_session_stop',
    annotations: DESTRUCTIVE,
    scope: 'kill',
    description:
      "Stop a session's agent process. The session stays in the list as exited; atc_session_forget removes it. Returns { stopped: true } when the call stopped or suspended a live process, and { stopped: false } when the session had already exited, which changes nothing. A live session's live sub-sessions stop with it; stopping an exited session leaves its sub-sessions running. On an imp the host is suspended, not destroyed: a session that owns its host puts the host to sleep with every session on it, their processes kept for a later atc_session_adopt, and the call fails with host_leased or host_unavailable while the host cannot sleep. A sub-session that shares its parent's imp host is killed instead, and so is a sub-session on an imp of its own when its parent stops and that host fails to suspend. An unknown id is refused with no_such_session.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_STOP_OUTPUT,
  },
  {
    name: 'atc_session_forget',
    annotations: DESTRUCTIVE,
    scope: 'kill',
    description:
      "Remove a session from the list for good. On an imp target this destroys the host and everything on it, so it takes two calls: the first changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token, returns { forgotten: true, destroyed: true }. The second call spends the token before it destroys anything, so a destroy that fails needs a new token from a call without one; a spent, expired or unknown token is refused with confirm_token_invalid. A sub-session that shares its parent's imp host needs the token too but keeps the host (destroyed: false). On any other target one call returns { forgotten: true, destroyed: false }. Refused: a live session unless stop is true, a pinned session, and a sub-session of a pinned session (unpin it, or detach the sub-session with parent null, through atc_session_update first). One exception: a call from inside a session may forget its own sub-sessions while that session is pinned, but not one that carries a pin of its own. Live sub-sessions on a host that survives move to the top level, and so do sub-sessions with a pin of their own and sub-sessions on an imp of their own. A sub-session asleep in its parent's imp host is refused with unsupported_operation (problem host_asleep): adopt it, or forget its parent, first.",
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
    outputSchema: SESSION_FORGET_OUTPUT,
    requires: { tool: 'session.forget' },
  },
  {
    name: 'atc_session_adopt',
    annotations: AGENT_FACING_DESTRUCTIVE,
    scope: 'spawn',
    description:
      "Start a terminal for a session that has none, resuming its agent session, as the TUI's P key does: a session a restore left without a terminal, an exited session such as one atc_session_stop stopped, or one that runs headless. A headless turn still running stops before the terminal is set up, and it stays stopped when that setup is then refused, such as with auth_rebind_required: the session is left with neither the turn nor a terminal, so adopt a session that runs a headless turn only when you mean to end that turn. On an imp the host wakes first, every other session asleep on it revives, and a harness still running there is attached instead of started again, unless it launched under an older auth revision than its host holds, which ends it and starts a new one that resumes the agent session; the call returns after those revives. Use it after atc_session_auth_rebind for a session whose restore was refused with auth_rebind_required. Returns { adopted: true } once the terminal starts; that does not show the agent booted, so check with atc_session_get or atc_terminal_read. Refused with session_dead when atc finds nothing to resume, an unknown session id included, which leaves the session as it was. A pin never refuses an adopt. A remote client is refused with no_such_session for a session whose tree runs on a target outside its reach, as atc_session_stop and atc_session_forget refuse it. Refused with no_such_session when the session already has a terminal or another adopt of it runs; that refusal, and a refusal of the session's target, can come after a running headless turn stopped. A retry once the terminal runs is refused and starts nothing.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_ADOPT_OUTPUT,
  },
  {
    name: 'atc_session_auth_rebind',
    annotations: DESTRUCTIVE,
    scope: 'spawn',
    description:
      "Bind the runtime auth of a session's host to the auth profiles its agent selects now, at the next revision. Use it when atc_session_adopt or a restore is refused with auth_rebind_required because the agent's auth profiles changed, or with auth_blocked after a revoke or a failed rebind; then start the session with atc_session_adopt, since a rebind starts nothing. The host gains every grant the agent's auth profiles now select and loses every grant they no longer select, for every session on that host. A harness keeps the settings it launched with until its next launch, and a rebind restarts none: restart a running session with atc_session_stop then atc_session_adopt. Returns { revision, restartPending }: the new revision, and the sessions on the host whose harness still holds an older revision's settings. Open to the daemon's owner only: a remote client is refused with unauthorized. Refused with unsupported_operation for a host with no auth binding, or for an agent that takes no credential from impd's broker, such as one whose auth block was dropped from the config: put the block back, or forget the session. Refused with auth_blocked while the binding is in another state, such as a revoke still pending. Launches on the host are refused with auth_blocked while a rebind runs. A rebind whose grant step fails leaves the host blocked at its old revision until a rebind succeeds; one refused before that step leaves the binding as it was. Each call that succeeds moves the binding to a new revision, a retry included.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_AUTH_REBIND_OUTPUT,
    requires: { tool: 'session.auth' },
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
      "List the directories earlier spawns used, newest first, as candidates for atc_session_spawn's cwd. The list merges every target and drops which one each path came from, so a path can be on another host. atc checks neither that a directory still exists nor that a spawn takes it: a directory atc picked for a git workspace is in the list, and a spawn with a workspace refuses an existing cwd. A remote client sees only the directories of targets it reaches. Under the gateway, daemon picks whose history to read; without it the default daemon's.",
    inputSchema: DIRS_INPUT,
    outputSchema: DIRS_OUTPUT,
    requires: { inputs: { daemon: 'fleet.daemons' } },
  },
  {
    name: 'atc_daemons_list',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "List the daemons this gateway routes to: name, state (up, down, unauthorized or changed), build, daemonID and features, plus defaultDaemon, where a spawn without daemon goes. It reads each daemon's handshake only, so a daemon too old for a tool still reads up here; a daemon that is not up has build null and no features. Session and message ids start with the daemon's name and incarnation, so an id shows which daemon holds it.",
    inputSchema: NO_INPUT,
    outputSchema: DAEMONS_OUTPUT,
    requires: { tool: 'fleet.daemons' },
  },
  {
    name: 'atc_spawn_options_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      'Read what atc_session_spawn accepts on this daemon: each agent (pass its id as agent) with whether it is installed, its capabilities, and the model and effort values it takes; each execution target (pass its id as target) with whether it is available; and spawnDefaults. A spawn that would fail says so in advance: an agent with installed false or capabilities.spawn false, a target with available false, or an entry in targetErrors, with their meanings in the output schema. available true does not show that the host of the target is up. A remote client sees only the targets it reaches, and no config-wide targetErrors. Under the gateway it returns daemons, an object keyed by daemon name that holds the state of each daemon and, for a daemon that is up, the object a single daemon returns. It never holds credentials, environment values or endpoints.',
    inputSchema: NO_INPUT,
    outputSchema: AGENTS_OUTPUT,
    requires: { tool: 'agents.list', output: 'spawn.options', outputUnless: 'fleet.daemons' },
  },
  {
    name: 'atc_session_get',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read one session: its entry as atc_sessions_list shows it, the prompt it was spawned with, when atc last recorded activity for it, pending (an object with the agent's notification text while it is needs_you, such as \"Claude needs your permission\"; never a menu's options), result (the final reply of its latest finished turn) and sessionRecord (the scope atc recorded for it). atc_terminal_choose reads and answers a Claude Code menu, such as a permission prompt; a person answers any other agent's menu in the TUI. An unknown session, or one a remote client cannot reach, is refused with no_such_session.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_GET_OUTPUT,
  },
  {
    name: 'atc_transcript_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read a session's conversation log a page at a time, oldest first: user and assistant messages, with tool uses summarised. Pass the returned cursor to continue; more is true when the page stopped at limit or at its size cap, even when the log ends there, so a page with no rows ends the read. A cursor from before the session moved to a new log file reads the new log from its start. A line over 1 MiB is skipped. Claude and Claude-compatible agents only; other agents return unsupported, and an unknown session returns no_such_session.",
    inputSchema: SESSION_READ_INPUT,
    outputSchema: TRANSCRIPT_OUTPUT,
  },
  {
    name: 'atc_events_read',
    annotations: READ_ONLY,
    scope: 'read',
    description:
      "Read the fleet's event feed: the one call to catch up on session state changes, the notes sessions send, and the progress of messages you sent, oldest first. To wait on one message, use atc_message_get; for a session's conversation itself, use atc_transcript_read. It holds session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-queued, message-delivered, message-answered with the full answer, cut at 64 KiB, message-unanswered, each with the message id), answer notice events under the sending session (notice-queued, notice-delivered, with the message id) and notes (note, with its label and full text, cut at 64 KiB). Pass the returned cursor on the next call; more true means the page stopped early, so read again at once. Without a cursor it returns the latest events, and more never counts the older ones. waitMs holds the call until an event arrives, up to 30000; use it instead of polling. session limits the read to one session; previewOnly true returns 600-character previews of notes and answers instead. atc deletes events older than 30 days, except the newest event of each session. A partial read says so: complete false or textError on a note or an answer, and, under the gateway, unavailable, started or truncated, with their meanings in the output schema.",
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
      "Send a message to a session's agent and get its id back. The message goes into the agent's conversation, never into the terminal, and the agent's answer is stored on the message. Sent from inside an atc session that takes messages, the outcome also reaches your own conversation by itself as an <atc-answer id=\"...\" status=\"answered|unanswered\"> notice once the message is answered or unanswered; it needs no reply and no atc_message_get call. A caller with no inbox (outside a session, a remote client, or a session whose agent takes no messages) follows with atc_message_get and waitMs until status is answered or unanswered. status is queued (waiting in atc's inbox), delivered (handed to the session, not yet confirmed as seen by the model), answered, or unanswered: the turn that carried the message ended without an answer (interrupted, an error, a refusal, or the prompt never started a turn) or the session's process ended while atc held the message delivered, with the cause in unansweredReason. A message still queued when the process ends stays queued for the session's next process. A message to a session that waits for its restore after a daemon restart queues the same way, and atc hands it to the session's message bridge once the bridge attaches. unanswered is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith in atc_message_get lists the others. Refused: unsupported when the agent takes no messages (capabilities.message false in atc_spawn_options_get), or when its message bridge has not attached 15 seconds after the session started; session_dead when the session's state is exited in atc_sessions_list, an asleep session included: start it again with atc_session_adopt, then send; no_such_session for an unknown id. The call cannot say who the message is from: atc labels it with the caller, a remote client by its client name, a session by its session id and name, and any other caller as the owner, and the receiving agent sees that label. A retry with the same idempotencyKey and text returns the same message with its current status. A refused send leaves no key on the daemon, so send it again under a new key: under the gateway, a retry with the same key returns outcome_unknown and sends nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: { type: 'string', description: 'The message text' },
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
      'Read one message sent with atc_message_send. A sender inside an atc session that takes messages gets the outcome as an <atc-answer> notice. Every other caller has no inbox, so this read is how it learns the outcome: a caller outside a session, a remote client, or a session whose agent takes no messages (capabilities.message false in atc_spawn_options_get). A caller may also use it to wait on one message. It returns the message with its status (queued, delivered, answered or unanswered), the answer once answered and unansweredReason once unanswered; the output schema holds the meaning of each field. unanswered means the turn that carried the message ended without an answer, or the process of its session ended while the message was delivered (unansweredReason session_ended), and is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith lists the others. Pass waitMs, up to 30000, to hold the call until the status changes; an answered or unanswered message returns at once. Ids and statuses persist, so call again after a timeout. An unknown id, or one whose session the caller cannot see, is refused with bad_args.',
    inputSchema: MESSAGE_GET_INPUT,
    outputSchema: MESSAGE_OUTPUT,
    requires: { output: 'message.turn', inputs: { waitMs: 'message.wait' } },
  },
];
