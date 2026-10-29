import type { AgentEntry } from '@atc/config';
import { resolveAgentHome } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import { toShellArg } from '@atc/core';
import type {
  AgentAdapter,
  AgentHomeLocation,
  AgentProfile,
  LineInputStep,
  TerminalInputModes,
} from '@atc/plugin-api';
import { planPastedLineInput } from '@atc/plugin-api';
import type { AgentSessionID, SpawnOptionSpec } from '@atcx/contract';
import { loadGrokName } from './load-grok-name';
import { planGrokHookEvents } from './plan-grok-hook-events';

export interface GrokAdapter extends AgentAdapter {
  // The hook files a user installs print the kind for every entry of it, so
  // the hook lines of every grok entry carry it.
  readonly hookAgent: AgentID;
  readonly profile: AgentProfile;

  // Grok's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  // Shell command that re-opens this session outside atc (or anywhere).
  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
  ) => string | null;
}

// atc passes Grok neither a model nor an effort; the CLI's own config picks both.
const GROK_UNSUPPORTED_OPTION: SpawnOptionSpec = {
  supported: false,
  values: null,
  examples: [],
  default: null,
  backendEffect: null,
  note: 'atc does not pass this option to Grok.',
};

const GROK_HOME_LOCATION: AgentHomeLocation = { env: 'GROK_HOME', folder: '.grok' };

// the state the hook mapping reads travels with each session's hook lines, so the adapter holds
// none
export function createGrokAdapter(entry: AgentEntry, home: string | null = null): GrokAdapter {
  const resolveHome = (): string =>
    home ?? resolveAgentHome(GROK_HOME_LOCATION.env, GROK_HOME_LOCATION.folder);

  return {
    id: entry.id,
    hookAgent: 'grok',

    // Grok has no headless handoff.
    headlessRunner: null,

    // Grok's hooks are authoritative; no screen heuristics needed.
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
    }),

    agentHomeLocation: GROK_HOME_LOCATION,

    planHookEvents: (hookEvent, previous, sessionHost) =>
      planGrokHookEvents(hookEvent, previous, sessionHost.agentHome ?? resolveHome()),

    loadName: (source, namedBy, sessionHost) =>
      loadGrokName(sessionHost.agentHome ?? resolveHome(), source, namedBy, sessionHost.files),

    canResume: (session) => session.agentSessionID !== undefined,

    planResumeCommand: (cwd, agentSessionID) => {
      const resume = agentSessionID === undefined ? 'grok' : `grok --resume ${agentSessionID}`;

      return `cd ${toShellArg(cwd)} && ${resume}`;
    },
  };
}
