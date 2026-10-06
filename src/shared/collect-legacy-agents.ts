import type { AgentEntry } from './collect-agents';
import type { AuthProfile } from './collect-auth-profiles';
import { collectClaudeAuth } from './collect-claude-auth';
import { collectGateways } from './collect-gateways';

/**
 * The agent keys of the old config.json shape, already defaulted: a binary and arguments per harness, and the raw `claudeAuth`
 * and `gateways` values.
 */
interface LegacyAgentKeys {
  readonly claudeBin: string;
  readonly claudeArgs: readonly string[];
  readonly claudeAuth: unknown;
  readonly grokBin: string;
  readonly grokArgs: readonly string[];
  readonly codexBin: string;
  readonly codexArgs: readonly string[];
  readonly gateways: unknown;
}

interface LegacyAgents {
  readonly agents: AgentEntry[];

  // The problems that left a Claude auth or a gateway out, in the text the
  // old keys always reported.
  readonly errors: string[];
}

/**
 * Translates the old agent keys to registry entries: `claude`, `grok`, and
 * `codex` in that order, then each gateway the old parse accepts, in file
 * order. The parse is the old lenient one, so an absent or wrong-typed field
 * takes its default.
 */
export function collectLegacyAgents(
  keys: LegacyAgentKeys,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): LegacyAgents {
  const claudeAuth = collectClaudeAuth(keys.claudeAuth, authProfiles);
  const gateways = collectGateways(keys.gateways, keys.claudeBin, keys.claudeArgs, authProfiles);

  const agents: AgentEntry[] = [
    {
      id: 'claude',
      kind: 'claude',
      label: 'Claude',
      mark: 'c',
      bin: keys.claudeBin,
      args: keys.claudeArgs,
      env: {},
      ...(claudeAuth.auth === null
        ? {}
        : { auth: { profiles: claudeAuth.auth.profiles, placeholderEnv: {} } }),
      ...(claudeAuth.auth === null || claudeAuth.auth.mcpServers.length === 0
        ? {}
        : { mcpServers: claudeAuth.auth.mcpServers }),
    },
    {
      id: 'grok',
      kind: 'grok',
      label: 'Grok',
      mark: 'g',
      bin: keys.grokBin,
      args: keys.grokArgs,
      env: {},
    },
    {
      id: 'codex',
      kind: 'codex',
      label: 'Codex',
      mark: 'c',
      bin: keys.codexBin,
      args: keys.codexArgs,
      env: {},
    },
    ...gateways.gateways.map((gateway): AgentEntry => ({ ...gateway, kind: 'claude' })),
  ];

  return { agents, errors: [...claudeAuth.errors, ...gateways.errors] };
}
