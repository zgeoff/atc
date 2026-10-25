import { z } from 'zod';
import { SOURCE_ENTRY_SCHEMA } from './source-entry';
import { SPAWN_OPTION_SPEC_SCHEMA } from './spawn-option-spec';

// A spawn option as `agents.list` shows it: the agent's own spec, plus
// whether a spawn can pass it now. Only the supported option of an agent
// some target can start is available.
const SPAWN_OPTION_ENTRY_SCHEMA = SPAWN_OPTION_SPEC_SCHEMA.extend({ available: z.boolean() });

export const AGENT_ENTRY_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),

  // whether the agent's binary resolves, on PATH or at its configured path
  installed: z.boolean(),

  // whether the agent takes its credential from the broker of a target
  // whose entry has `brokerAuth`
  brokerAuth: z.boolean(),

  // whether it starts only there; false for an agent that starts on any
  // other target under the sign-in that target's host holds
  brokerRequired: z.boolean(),

  // the targets a spawn of the agent can start on: none when its starts are
  // all refused, only those that reach a broker when it starts only
  // there, and only a remote target when its binary is missing here
  spawnTargets: z.array(z.string()).readonly(),
  capabilities: z.object({
    // whether some target can start a session of the agent
    spawn: z.boolean(),
    readTranscript: z.boolean(),

    // whether a session takes inbox messages through a tap
    message: z.boolean(),
    attach: z.boolean(),
    screen: z.boolean(),
    input: z.boolean(),
  }),
  models: z.record(z.string(), z.string()).nullable(),
  spawnOptions: z.object({
    model: SPAWN_OPTION_ENTRY_SCHEMA,
    effort: SPAWN_OPTION_ENTRY_SCHEMA,
    pluginDirs: SPAWN_OPTION_ENTRY_SCHEMA,
  }),
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

  // whether its provider runs a session on a machine other than the daemon's
  remote: z.boolean(),
  default: z.boolean(),
  capabilities: EXECUTION_CAPABILITIES_SCHEMA,

  // whether the target's provider reaches a credential broker
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
