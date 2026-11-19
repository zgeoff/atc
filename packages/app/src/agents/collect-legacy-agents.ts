import type { AgentEntry } from '@atc/config';
import { isRecord } from '@atc/core';
import { collectClaudeAuth, collectGateways } from '@atc/harness-claude';
import type { AuthProfile } from '@atc/plugin-api';

// the caller has already filled each absent key with its default.
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

export function collectLegacyAgents(
  keys: LegacyAgentKeys,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): LegacyAgents {
  // the old parse is lenient: an absent or wrong-typed field takes its default.
  const claudeAuth = collectLegacyClaudeAuth(keys.claudeAuth, authProfiles);
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

// The old key's Claude auth, which never takes placeholders: only an entry
// in the agents map binds a variable to a profile.
function collectLegacyClaudeAuth(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): ReturnType<typeof collectClaudeAuth> {
  if (isRecord(raw) && Object.hasOwn(raw, 'placeholderEnv')) {
    return {
      auth: null,
      errors: [
        'claudeAuth.placeholderEnv cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
      ],
    };
  }

  return collectClaudeAuth(raw, authProfiles);
}
