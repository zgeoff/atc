import type {
  AdapterEvent,
  AgentAdapter,
  AgentID,
  HeadlessRunner,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { ClaudeAdapter } from './claude-adapter';
import type { GatewayConfig } from './collect-gateways';
import type { Config } from './config';
import type { HookEvent } from './hooks';
import { toShellArg } from './to-shell-arg';
import { writeHookSettings } from './write-hook-settings';

/**
 * The Claude CLI pointed at a Claude-compatible backend other than the
 * default one. Hooks, transcripts, and resume semantics are the CLI's, so
 * they come straight from the Claude adapter; only the spawn plan and the
 * resume command differ, because both have to name the settings file that
 * carries the backend.
 */
export class GatewayAdapter implements AgentAdapter {
  readonly id: AgentID;

  // A headless turn carries the same settings file the terminal spawn does,
  // so it reaches this backend rather than the default one.
  readonly headlessRunner: HeadlessRunner | null;

  // The CLI's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly gateway: GatewayConfig;

  private readonly claude: ClaudeAdapter;

  // Written on first spawn so constructing the adapter touches no state.
  private settingsFile: string | undefined;

  constructor(
    gateway: GatewayConfig,
    config: Config,
    headlessRunner: HeadlessRunner | null = null,
  ) {
    this.gateway = gateway;
    this.id = gateway.id;

    this.claude = new ClaudeAdapter(config);

    this.headlessRunner =
      headlessRunner === null
        ? null
        : (opts, hooks) => headlessRunner({ ...opts, settings: this.writeSettings() }, hooks);
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.gateway.bin,
      args: [
        ...this.gateway.args,
        '--settings',
        this.writeSettings(),
        ...(opts.resume === true ? ['--resume'] : []),
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    return this.claude.normalizeHook(e);
  }

  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    return this.claude.loadName(source, namedBy);
  }

  canResume(session: ResumeCheck): boolean {
    return this.claude.canResume(session);
  }

  // Shell command that re-opens this session outside atc. It names the
  // generated settings file, because without it the CLI would resume the
  // session against the default backend.
  buildResumeCommand(cwd: string, agentSessionID: string | undefined): string | null {
    const settings = toShellArg(this.writeSettings());
    const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${this.gateway.bin} --settings ${settings} --resume${resume}`;
  }

  private writeSettings(): string {
    this.settingsFile ??= writeHookSettings({
      id: this.id,
      env: { ANTHROPIC_BASE_URL: this.gateway.baseURL, ...this.gateway.env },
      ...(this.gateway.apiKeyHelper === undefined
        ? {}
        : { apiKeyHelper: this.gateway.apiKeyHelper }),
    });

    return this.settingsFile;
  }
}
