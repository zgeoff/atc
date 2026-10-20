import type { AgentEntry } from '@atc/config';
import { resolveAgentHome } from '@atc/config/host';
import type { AgentID, AgentSessionID } from '@atc/core';
import { toShellArg } from '@atc/core';
import type {
  AgentAdapter,
  AgentProfile,
  HookPlan,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from '@atc/plugin-api';
import { planPastedLineInput } from '@atc/plugin-api';
import type { SpawnOptionSpec } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { loadGrokName } from './load-grok-name';
import { planGrokHookEvents } from './plan-grok-hook-events';

// atc passes Grok neither a model nor an effort; the CLI's own config picks both.
const GROK_UNSUPPORTED_OPTION: SpawnOptionSpec = {
  supported: false,
  values: null,
  examples: [],
  default: null,
  backendEffect: null,
  note: 'atc does not pass this option to Grok.',
};

// the state the hook mapping reads travels with each session's hook lines, so the adapter holds
// none
export class GrokAdapter implements AgentAdapter {
  readonly id: AgentID;

  // The hook files a user installs print the kind for every entry of it, so
  // the hook lines of every grok entry carry it.
  readonly hookAgent = 'grok';

  // Grok has no headless handoff.
  readonly headlessRunner = null;

  // Grok's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  readonly profile: AgentProfile;

  readonly takesMessages = false;

  // Grok's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted.
  readonly planLineInput = planPastedLineInput;

  private readonly entry: AgentEntry;

  // Grok's home directory, or null to read it from GROK_HOME (or ~/.grok)
  // each time it is needed.
  private readonly home: string | null;

  constructor(entry: AgentEntry, home: string | null = null) {
    this.entry = entry;
    this.home = home;
    this.id = entry.id;

    this.profile = {
      label: entry.label,
      kind: 'grok',
      bin: entry.bin,
      models: null,
      spawnOptions: { model: GROK_UNSUPPORTED_OPTION, effort: GROK_UNSUPPORTED_OPTION },
    };
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.entry.bin,
      args: [
        ...this.entry.args.filter((arg) => arg !== '--leader' && arg !== '--no-leader'),
        '--no-leader',
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  planHookEvents(hookEvent: HookEvent, previous: unknown): HookPlan {
    return planGrokHookEvents(hookEvent, previous, this.resolveHome());
  }

  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    return loadGrokName(this.resolveHome(), source, namedBy);
  }

  canResume(session: ResumeCheck): boolean {
    return session.agentSessionID !== undefined;
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  planResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume = agentSessionID === undefined ? 'grok' : `grok --resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }

  private resolveHome(): string {
    return this.home ?? resolveAgentHome('GROK_HOME', '.grok');
  }
}
