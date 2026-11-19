import { z } from 'zod';
import { SOURCE_ENTRY_SCHEMA } from '../sources/source-entry';
import { SPAWN_OPTION_SPEC_SCHEMA } from '../sources/spawn-option-spec';

const SPAWN_OPTION_ENTRY_SCHEMA = SPAWN_OPTION_SPEC_SCHEMA.extend({ available: z.boolean() });

export const AGENT_ENTRY_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),

  installed: z.boolean(),

  brokerAuth: z.boolean(),

  // whether the agent starts only on a target whose broker supplies its credential; false when
  // it can also start on another target under the sign-in that target's host holds
  brokerRequired: z.boolean(),

  spawnTargets: z.array(z.string()).readonly(),
  capabilities: z.object({
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

// Terminal access is split into separate flags because some hosts can show output but cannot
// take input or resize, and need to report that.
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
  relay: z.boolean(),
});

const TARGET_ENTRY_SCHEMA = z.object({
  id: z.string(),

  provider: z.string(),

  identity: z.string(),

  available: z.boolean(),

  remote: z.boolean(),
  default: z.boolean(),
  capabilities: EXECUTION_CAPABILITIES_SCHEMA,

  brokerAuth: z.boolean(),
});

export type TargetEntry = z.output<typeof TARGET_ENTRY_SCHEMA>;

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
