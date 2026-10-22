import type { AgentEntry, AgentEntryRead } from '@atc/config';
import { collectProfileEnvProblems, resolveAuthProfiles } from '@atc/config';
import { isRecord, isSubscriptionOverrideVariable } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';
import { checkGatewayAuth } from './check-gateway-auth';
import { collectClaudeAuth } from './collect-claude-auth';

interface ClaudeEntryArgs {
  readonly entry: AgentEntry;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export function readClaudeEntry(args: ClaudeEntryArgs): AgentEntryRead {
  const entry = args.entry;
  const raw = args.raw['auth'];

  if (entry.baseURL !== undefined) {
    if (raw === undefined) {
      return { entry, warnings: [] };
    }

    const checked = checkGatewayAuth(
      raw,
      {
        baseURL: entry.baseURL,
        env: entry.env,
        settings: entry.settings,
      },
      args.authProfiles,
    );

    return Array.isArray(checked)
      ? { problems: checked }
      : { entry: { ...entry, auth: checked }, warnings: [] };
  }

  const problems =
    entry.apiKeyHelper === undefined ? [] : ['apiKeyHelper is only valid together with baseURL'];

  if (raw === undefined) {
    return problems.length > 0 ? { problems } : { entry, warnings: [] };
  }

  const collected = collectClaudeAuth(raw, args.authProfiles, 'auth');

  problems.push(...collectSubscriptionProblems(entry));

  if (collected.auth === null) {
    return { problems: [...collected.errors, ...problems] };
  }

  problems.push(
    ...collectEntryProfileEnvProblems(entry, collected.auth.profiles, args.authProfiles),
    ...collectPlaceholderOverrideProblems(entry, collected.auth.placeholderEnv),
  );

  if (problems.length > 0) {
    return { problems };
  }

  return {
    entry: {
      ...entry,
      auth: { profiles: collected.auth.profiles, placeholderEnv: collected.auth.placeholderEnv },
      ...(collected.auth.mcpServers.length === 0 ? {} : { mcpServers: collected.auth.mcpServers }),
    },
    warnings: collected.errors,
  };
}

const OVERRIDE_REASON = ', which would override or route around the subscription sign-in';

// What a stock entry with `auth` sets that would override the subscription
// sign-in or route the CLI around the target's broker.
function collectSubscriptionProblems(entry: AgentEntry): string[] {
  const settingsEnv = entry.settings?.['env'];

  const settingsKeys =
    isRecord(settingsEnv) && !Array.isArray(settingsEnv) ? Object.keys(settingsEnv) : [];

  const problems = [
    ...Object.keys(entry.env)
      .filter((key) => isSubscriptionOverrideVariable(key))
      .map((key) => `env must not set ${key}${OVERRIDE_REASON}`),
    ...settingsKeys
      .filter((key) => isSubscriptionOverrideVariable(key))
      .map((key) => `settings.env must not set ${key}${OVERRIDE_REASON}`),
  ];

  if (entry.settings?.['apiKeyHelper'] !== undefined) {
    problems.push(
      'settings.apiKeyHelper must not be set, which would override the subscription sign-in',
    );
  }

  return problems;
}

// The variables a stock entry sets that its selected profiles also set.
function collectEntryProfileEnvProblems(
  entry: AgentEntry,
  selected: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile>,
): string[] {
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return [];
  }

  const settingsEnv = entry.settings?.['env'];

  return collectProfileEnvProblems(
    [
      ['env', Object.keys(entry.env)],
      [
        'settings.env',
        isRecord(settingsEnv) && !Array.isArray(settingsEnv) ? Object.keys(settingsEnv) : [],
      ],
    ],
    resolution.resolved.envOwners,
  );
}

// The placeholders a stock entry's env or settings env also sets, whose
// value would replace the placeholder.
function collectPlaceholderOverrideProblems(
  entry: AgentEntry,
  placeholderEnv: Readonly<Record<string, string>>,
): string[] {
  const settingsEnv = entry.settings?.['env'];

  const sources = [
    ['env', Object.keys(entry.env)],
    [
      'settings.env',
      isRecord(settingsEnv) && !Array.isArray(settingsEnv) ? Object.keys(settingsEnv) : [],
    ],
  ] as const;

  return Object.keys(placeholderEnv).flatMap((key) =>
    sources
      .filter(([, keys]) => keys.includes(key))
      .map(
        ([source]) =>
          `auth.placeholderEnv.${key} is also set in ${source}, which would override it`,
      ),
  );
}
