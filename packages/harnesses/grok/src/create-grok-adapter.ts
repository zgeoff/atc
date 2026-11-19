import type { AgentEntry } from '@atc/config';
import { resolveAgentHome, stateDir } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import type {
  AgentAdapter,
  AgentHomeLocation,
  AgentProfile,
  LineInputStep,
  TerminalInputModes,
} from '@atc/plugin-api';
import { formatResumeCommand, makeAgentEnvFileSyncer, planPastedLineInput } from '@atc/plugin-api';
import type { AgentSessionID, SpawnOptionSpec } from '@atcx/contract';
import { loadGrokName } from './load-grok-name';
import { planGrokHookEvents } from './plan-grok-hook-events';

export interface GrokAdapter extends AgentAdapter {
  readonly hookAgent: AgentID;
  readonly profile: AgentProfile;

  // Grok's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
  ) => string | null;
}

const GROK_UNSUPPORTED_OPTION: SpawnOptionSpec = {
  supported: false,
  values: null,
  examples: [],
  default: null,
  backendEffect: null,
  note: 'atc does not pass this option to Grok.',
};

const GROK_HOME_LOCATION: AgentHomeLocation = { env: 'GROK_HOME', folder: '.grok' };

export function createGrokAdapter(
  entry: AgentEntry,
  home: string | null = null,
  stateDirectory: string = stateDir,
): GrokAdapter {
  const syncEnvFile = makeAgentEnvFileSyncer(entry, stateDirectory);

  const resolveHome = (): string =>
    home ?? resolveAgentHome(GROK_HOME_LOCATION.env, GROK_HOME_LOCATION.folder);

  return {
    id: entry.id,
    hookAgent: 'grok',

    headlessRunner: null,

    screenDetector: null,

    profile: {
      label: entry.label,
      kind: 'grok',
      bin: entry.bin,
      models: null,
      spawnOptions: { model: GROK_UNSUPPORTED_OPTION, effort: GROK_UNSUPPORTED_OPTION },
    },

    takesMessages: false,
    planLineInput: planPastedLineInput,

    planSpawn: (opts) => ({
      bin: entry.bin,
      args: [
        ...entry.args.filter((arg) => arg !== '--leader' && arg !== '--no-leader'),
        '--no-leader',
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
      ...(Object.keys(entry.env).length === 0 ? {} : { env: entry.env }),
    }),

    agentHomeLocation: GROK_HOME_LOCATION,

    planHookEvents: (hookEvent, previous, sessionHost) =>
      planGrokHookEvents(hookEvent, previous, sessionHost.agentHome ?? resolveHome()),

    loadName: (source, namedBy, sessionHost) =>
      loadGrokName(sessionHost.agentHome ?? resolveHome(), source, namedBy, sessionHost.files),

    canResume: (session) => session.agentSessionID !== undefined,

    planResumeCommand: (cwd, agentSessionID) => {
      const resume = agentSessionID === undefined ? 'grok' : `grok --resume ${agentSessionID}`;

      return formatResumeCommand(cwd, resume, syncEnvFile());
    },
  };
}
