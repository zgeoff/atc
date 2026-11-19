import { z } from 'zod';
import { DAEMON_FIELD } from './daemon-field';
import { NO_INPUT } from './no-input';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';

const DIRS_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({ daemon: DAEMON_FIELD }),
  { io: 'input' },
);

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
              "whether its binary resolves on the daemon's host; false refuses a spawn only on a target that runs the agent on that host, so an agent on a remote target can be false and still start, and spawnTargets shows where a spawn can start",
          },
          spawnTargets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'the ids of the targets a spawn of the agent can start on; empty when capabilities.spawn is false',
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
            description: 'the model, effort and plugin folder options a spawn takes',
            properties: {
              model: SPAWN_OPTION_OUTPUT,
              effort: SPAWN_OPTION_OUTPUT,
              pluginDirs: {
                ...SPAWN_OPTION_OUTPUT,
                description:
                  "the plugin folders a spawn can add for its session alone; available true when the agent can start on a target on the daemon's machine",
              },
            },
            required: ['model', 'effort', 'pluginDirs'],
          },
        },
        required: [
          'id',
          'label',
          'kind',
          'installed',
          'brokerAuth',
          'brokerRequired',
          'capabilities',
          'models',
          'spawnOptions',
        ],
      },
    },
    targets: {
      type: 'array',
      description: 'the execution targets',
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
        required: [
          'id',
          'provider',
          'identity',
          'available',
          'default',
          'capabilities',
          'brokerAuth',
        ],
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
  required: [
    'daemon',
    'agents',
    'targets',
    'spawnDefaults',
    'configRevision',
    'targetErrors',
    'sources',
  ],
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
              'up, down, unauthorized, changed (another daemon answers at its address) or mismatched (it runs an atc version the gateway cannot serve); a later gateway may add a value',
          },
          build: {
            type: ['string', 'null'],
            description: "the daemon's build; null unless the daemon is up",
          },
          daemonID: {
            type: 'string',
            description: 'the daemon identity the gateway expects at that address',
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

export const FLEET_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_recent_dirs_list',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "List the directories earlier spawns used, newest first, as candidates for atc_session_spawn's cwd. The list merges every target and drops which one each path came from, so a path can be on another host. atc checks neither that a directory still exists nor that a spawn takes it: a directory atc picked for a git workspace is in the list, and a spawn with a workspace refuses an existing cwd. A remote client sees only the directories of targets it reaches. Under the gateway, daemon picks whose history to read; without it the default daemon's.",
    inputSchema: DIRS_INPUT,
    outputSchema: DIRS_OUTPUT,
    requires: { inputs: { daemon: 'fleet.daemons' } },
  },
  {
    name: 'atc_daemons_list',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "List the daemons this gateway routes to: name, state (up, down, unauthorized, changed or mismatched), build, and daemonID, plus defaultDaemon, where a spawn without daemon goes. It reads each daemon's handshake only; a daemon that is not up has build null. A mismatched daemon runs another major atc version or another protocol version than the gateway, and every call to it fails with daemon_unavailable until the older of the two is upgraded. Session and message ids start with the daemon's name and incarnation, so an id shows which daemon holds it.",
    inputSchema: NO_INPUT,
    outputSchema: DAEMONS_OUTPUT,
    requires: { tool: 'fleet.daemons' },
  },
  {
    name: 'atc_spawn_options_get',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      'Read what atc_session_spawn accepts on this daemon: each agent (pass its id as agent) with whether it is installed, its capabilities, the model and effort values it takes, and whether it takes plugin folders; each execution target (pass its id as target) with whether it is available; and spawnDefaults. A spawn that would fail says so in advance: an agent with capabilities.spawn false, a target missing from the spawnTargets of the agent, a target with available false, or an entry in targetErrors, with their meanings in the output schema. available true does not show that the host of the target is up. A remote client sees only the targets it reaches, and no config-wide targetErrors. Under the gateway it returns daemons, an object keyed by daemon name that holds the state of each daemon and, for a daemon that is up, the object a single daemon returns. It never holds credentials, environment values or endpoints.',
    inputSchema: NO_INPUT,
    outputSchema: AGENTS_OUTPUT,
    requires: { outputUnless: 'fleet.daemons' },
  },
];
