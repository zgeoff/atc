import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toDaemonID } from '@atc/core/to-daemon-id';
import { toSessionID } from '@atc/core/to-session-id';
import { z } from 'zod';
import { SESSION_LIFECYCLE_SCHEMA } from './session-lifecycle';
import { SESSION_WORKSPACE_SCHEMA } from './session-workspace';

/**
 * The session view: one session as the daemon reports it to clients, in
 * `session.list`, `session.get` and the session events.
 */
export const SESSION_DESCRIPTOR_SCHEMA = z.object({
  id: z.string().transform((id) => toSessionID(id)),
  name: z.string(),
  cwd: z.string(),
  state: z.enum(['running', 'needs_you', 'done', 'exited']),
  unread: z.boolean(),
  lastMsg: z.string(),
  lastDetail: z.string().optional(),
  agentSessionID: z
    .string()
    .transform((id) => toAgentSessionID(id))
    .optional(),
  agent: z.string(),
  pinned: z.boolean(),
  lastAttachedAt: z.number(),
  repoRoot: z.string(),
  namedBy: z.enum(['user', 'auto', 'agent']),
  createdAt: z.number(),
  kind: z.enum(['pty', 'headless']),
  alive: z.boolean(),

  // whether this session's agent can run a headless turn, so a client can
  // offer the eject action without knowing which agent it is
  canEject: z.boolean(),

  // the session this one is a sub-session of: it lists under that session
  // and inherits its pin, beside any pin of its own
  parent: z
    .string()
    .transform((id) => toSessionID(id))
    .optional(),

  // where the session runs: the daemon hosting it, and the execution target
  // on that daemon's host
  locator: z.object({
    daemonID: z.string().transform((id) => toDaemonID(id)),
    targetID: z.string(),
  }),

  // what the working directory was materialized from, for a session spawned
  // with a workspace source
  workspace: SESSION_WORKSPACE_SCHEMA.optional(),

  // what the operator asked for, the host, the harness, and the daemon's
  // connection to it; the state derives from these and the attention
  lifecycle: SESSION_LIFECYCLE_SCHEMA,

  // the model the session was spawned with; absent when it runs the agent's
  // default
  model: z.string().optional(),
});

export type SessionDescriptor = Readonly<z.output<typeof SESSION_DESCRIPTOR_SCHEMA>>;
