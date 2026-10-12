import { z } from 'zod';
import { SOURCE_ENTRY_SCHEMA } from './source-entry';
import { SPAWN_OPTION_SPEC_SCHEMA } from './spawn-option-spec';

// A spawn option as `agents.list` shows it: the agent's own spec, plus
// whether a spawn on this host can pass it now. Only an installed agent's
// supported option is available.
const SPAWN_OPTION_ENTRY_SCHEMA = SPAWN_OPTION_SPEC_SCHEMA.extend({ available: z.boolean() });

const AGENT_ENTRY_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),

  // whether the agent's binary resolves, on PATH or at its configured path
  installed: z.boolean(),

  // whether the agent takes its credential from impd's broker on a target
  // whose entry has `brokerAuth`
  brokerAuth: z.boolean(),

  // whether it starts only there; false for an agent that starts on any
  // other target under the sign-in that target's host holds
  brokerRequired: z.boolean(),
  capabilities: z.object({
    // only an installed agent whose starts are not all refused can start a
    // session, and one that starts only behind impd's broker only where
    // some target reaches the broker
    spawn: z.boolean(),
    readTranscript: z.boolean(),

    // whether a session takes inbox messages through a tap
    message: z.boolean(),
    attach: z.boolean(),
    screen: z.boolean(),
    input: z.boolean(),
  }),
  models: z.record(z.string(), z.string()).nullable(),
  spawnOptions: z.object({ model: SPAWN_OPTION_ENTRY_SCHEMA, effort: SPAWN_OPTION_ENTRY_SCHEMA }),
});

export type AgentEntry = z.output<typeof AGENT_ENTRY_SCHEMA>;

// What a provider can do; the terminal capabilities split so a host that
// can show output but not take input, or not resize, says so.
const EXECUTION_CAPABILITIES_SCHEMA = z.object({
  spawn: z.boolean(),
  attach: z.boolean(),
  input: z.boolean(),
  resize: z.boolean(),
  kill: z.boolean(),
  transfer: z.boolean(),
  run: z.boolean(),
  headless: z.boolean(),
  suspend: z.boolean(),
  destroy: z.boolean(),
});

const TARGET_ENTRY_SCHEMA = z.object({
  id: z.string(),

  // the provider kind the config selects for the target
  provider: z.string(),

  // the identity a session spawned on the target binds to
  identity: z.string(),

  // whether this daemon has a provider of that kind, so a spawn can run there
  available: z.boolean(),
  default: z.boolean(),
  capabilities: EXECUTION_CAPABILITIES_SCHEMA,

  // whether the target's provider reaches impd's credential broker
  brokerAuth: z.boolean(),
});

export type TargetEntry = z.output<typeof TARGET_ENTRY_SCHEMA>;

// A config problem that leaves a target, or every target, unusable.
const TARGET_CONFIG_ERROR_SCHEMA = z.union([
  z.object({
    scope: z.enum(['targets', 'target', 'defaultTarget']),
    target: z.string().optional(),
    problem: z.string(),
  }),
  z.object({
    scope: z.literal('config'),
    problem: z.enum(['config_malformed', 'config_unreadable']),
    path: z.string(),
    detail: z.string(),
  }),
]);

/**
 * The `agents.list` answer: the host the daemon runs on, each agent, each
 * execution target, what a spawn without either runs with, a digest of the
 * target config, the target config problems the daemon started with, and
 * the sources the spawn picker offers, in order.
 */
export const AGENT_LIST_SCHEMA = z.object({
  daemon: z.object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    build: z.string(),
  }),
  agents: z.array(AGENT_ENTRY_SCHEMA).readonly(),
  targets: z.array(TARGET_ENTRY_SCHEMA).readonly(),
  spawnDefaults: z.object({ agent: z.string(), target: z.string().nullable() }),
  configRevision: z.string(),
  targetErrors: z.array(TARGET_CONFIG_ERROR_SCHEMA).readonly(),
  sources: z.array(SOURCE_ENTRY_SCHEMA).readonly(),
});

export type AgentList = z.output<typeof AGENT_LIST_SCHEMA>;
