// A session's entry as the session tools return it.
export const SESSION_ENTRY_PROPERTIES: Readonly<Record<string, unknown>> = {
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
  pluginDirs: {
    type: 'array',
    items: { type: 'string' },
    description:
      "the plugin folders the spawn asked for, with ~ expanded; the folders the agent's config sets load too and are not listed. Absent when the spawn asked for none",
  },
  workspace: {
    type: 'object',
    description:
      'the repository and commit atc checked out for the session; absent without a workspace source',
  },
  locator: { type: 'object', description: 'the daemon and target the session runs on' },
  host: {
    type: 'object',
    description:
      "the VM host the session runs on, as the host provider names it; absent for a session with no VM host, such as a local one. A sub-session on its parent's host reports the same host",
    properties: {
      name: { type: 'string', description: "the host's name on its provider" },
      id: {
        type: 'string',
        description:
          "the provider's id for the host, which a new host made under the same name never shares; absent while atc does not know it",
      },
      issuer: {
        type: 'string',
        description:
          "the identity issuer of the provider's daemon; absent when that daemon reports none",
      },
    },
  },
  lifecycle: {
    type: 'object',
    description: "the wanted and actual state of the session's host, harness and attachment",
  },
};

export const SESSION_ENTRY: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: SESSION_ENTRY_PROPERTIES,
  required: [
    'id',
    'name',
    'cwd',
    'agent',
    'state',
    'unread',
    'pinned',
    'alive',
    'kind',
    'lastMsg',
    'createdAt',
    'locator',
    'lifecycle',
  ],
};

// A session record as atc publishes it to the session.
export const SESSION_RECORD: Readonly<Record<string, unknown>> = {
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
