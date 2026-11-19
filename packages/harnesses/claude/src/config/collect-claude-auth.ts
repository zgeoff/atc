import type { ClaudeMCPServer } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import { BROKER_PLACEHOLDER, isRecord, isSubscriptionOverrideVariable } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';

interface ClaudeAuth {
  readonly profiles: readonly string[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
  readonly mcpServers: readonly ClaudeMCPServer[];
}

interface CollectedClaudeAuth {
  readonly auth: ClaudeAuth | null;
  readonly errors: readonly string[];
}

// The one host Claude Code sends a subscription token to.
const ANTHROPIC_API_HOST = 'api.anthropic.com';

export function collectClaudeAuth(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
  field = 'claudeAuth',
): CollectedClaudeAuth {
  if (raw === undefined) {
    return { auth: null, errors: [] };
  }

  const profiles = isRecord(raw) ? raw['profiles'] : undefined;

  if (
    !isRecord(raw) ||
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    !profiles.every((name) => typeof name === 'string')
  ) {
    return {
      auth: null,
      errors: [`${field} must be an object with a non-empty profiles array`],
    };
  }

  const extra = Object.keys(raw).find(
    (key) => key !== 'profiles' && key !== 'placeholderEnv' && key !== 'mcpServers',
  );

  if (extra !== undefined) {
    return {
      auth: null,
      errors: [
        `${field}.${extra} cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session`,
      ],
    };
  }

  const selected = profiles.map(String);
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return { auth: null, errors: [`${field}: ${resolution.problem.message}`] };
  }

  const rule = resolution.resolved.secrets
    .flatMap((secret) => secret.rules)
    .find((candidate) => candidate.host === ANTHROPIC_API_HOST);

  if (rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
    return {
      auth: null,
      errors: [
        `${field} needs a profile that sets a bearer authorization header for ${ANTHROPIC_API_HOST}, where Claude Code sends its subscription token`,
      ],
    };
  }

  const placeholders = parsePlaceholderEnv(raw['placeholderEnv'], field, selected, {
    authProfiles,
    envOwners: resolution.resolved.envOwners,
  });

  if (Array.isArray(placeholders)) {
    return { auth: null, errors: placeholders };
  }

  const servers = collectMCPServers(raw['mcpServers'], field, selected, authProfiles);

  return {
    auth: { profiles: selected, placeholderEnv: placeholders, mcpServers: servers.servers },
    errors: servers.errors,
  };
}

interface PlaceholderContext {
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
  readonly envOwners: Readonly<Record<string, string>>;
}

function parsePlaceholderEnv(
  raw: unknown,
  field: string,
  selected: readonly string[],
  context: PlaceholderContext,
): Readonly<Record<string, string>> | string[] {
  if (raw === undefined) {
    return {};
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return [`${field}.placeholderEnv must be an object of variable names`];
  }

  const env: Record<string, string> = {};
  const errors: string[] = [];

  for (const [key, entry] of Object.entries(raw)) {
    const problem = findPlaceholderProblem({ key, entry, field, selected, context });

    if (problem === null) {
      env[key] = BROKER_PLACEHOLDER;
    } else {
      errors.push(`${field}.placeholderEnv.${key}: ${problem}`);
    }
  }

  return errors.length > 0 ? errors : env;
}

const VARIABLE_NAME = /^[A-Z_a-z]\w*$/u;

interface FindPlaceholderProblemOptions {
  readonly key: string;
  readonly entry: unknown;
  readonly field: string;
  readonly selected: readonly string[];
  readonly context: PlaceholderContext;
}

function findPlaceholderProblem(options: FindPlaceholderProblemOptions): string | null {
  if (!VARIABLE_NAME.test(options.key)) {
    return 'a variable name must be letters, digits or underscores, and not start with a digit';
  }

  if (isReservedVariable(options.key)) {
    return 'atc fixes the endpoint, the placeholder, and the launch variables of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, Codex, OpenAI, atc, launch, proxy or CA variable';
  }

  const owner = options.context.envOwners[options.key];

  if (owner !== undefined) {
    return `profile ${owner} sets ${options.key}, which the placeholder would replace`;
  }

  if (!isRecord(options.entry) || Array.isArray(options.entry)) {
    return 'a placeholder must be an object with the profile whose credential it stands in for';
  }

  const extra = Object.keys(options.entry).find((name) => name !== 'profile');

  if (extra !== undefined) {
    return `${extra} cannot be set: atc fixes the placeholder value`;
  }

  const profileName = options.entry['profile'];

  if (typeof profileName !== 'string' || !options.selected.includes(profileName)) {
    return `profile must be one of ${options.field}.profiles`;
  }

  const profile = options.context.authProfiles.get(profileName);

  if (profile === undefined || profile.kind === 'github') {
    return 'profile must be a custom or oauth profile, which sets one header for one host';
  }

  if (isAnthropicHost(profile.host)) {
    return `profile ${profileName} sends its credential to ${profile.host}, and atc fixes the placeholder of a credential sent to Anthropic`;
  }

  return null;
}

const LAUNCH_VARIABLES: ReadonlySet<string> = new Set(['HOME', 'PATH', 'TMPDIR']);

const RESERVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'ATC_'];

function isReservedVariable(key: string): boolean {
  const upper = key.toUpperCase();

  return (
    isSubscriptionOverrideVariable(key) ||
    LAUNCH_VARIABLES.has(upper) ||
    RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

const ANTHROPIC_DOMAINS = ['anthropic.com', 'claude.ai', 'claude.com'];

function isAnthropicHost(host: string): boolean {
  const name = host.toLowerCase();

  return ANTHROPIC_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

interface CollectedMCPServers {
  readonly servers: readonly ClaudeMCPServer[];
  readonly errors: readonly string[];
}

function collectMCPServers(
  raw: unknown,
  field: string,
  selected: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile>,
): CollectedMCPServers {
  if (raw === undefined) {
    return { servers: [], errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return { servers: [], errors: [`${field}.mcpServers must be an object of named servers`] };
  }

  const servers: ClaudeMCPServer[] = [];
  const errors: string[] = [];

  for (const [name, entry] of Object.entries(raw)) {
    const parsed = parseMCPServer({ name, entry, field, selected, authProfiles });

    if (typeof parsed === 'string') {
      errors.push(`${field}.mcpServers.${name}: ${parsed}`);
    } else {
      servers.push(parsed);
    }
  }

  return { servers, errors };
}

// Claude Code accepts only 1-64 word characters or hyphens in an MCP server name.
const MCP_SERVER_NAME = /^[\w-]{1,64}$/u;

interface ParseMCPServerOptions {
  readonly name: string;
  readonly entry: unknown;
  readonly field: string;
  readonly selected: readonly string[];
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

function parseMCPServer(options: ParseMCPServerOptions): ClaudeMCPServer | string {
  if (!MCP_SERVER_NAME.test(options.name)) {
    return 'a server name must be letters, digits, underscores or hyphens';
  }

  if (!isRecord(options.entry) || Array.isArray(options.entry)) {
    return 'a server must be an object with url and profile';
  }

  const extra = Object.keys(options.entry).find((key) => key !== 'url' && key !== 'profile');

  if (extra !== undefined) {
    return `${extra} cannot be set: atc fixes the transport and the placeholder header`;
  }

  const url = options.entry['url'];
  const profileName = options.entry['profile'];

  if (typeof profileName !== 'string' || !options.selected.includes(profileName)) {
    return `profile must be one of ${options.field}.profiles`;
  }

  const profile = options.authProfiles.get(profileName);

  if (profile?.kind !== 'custom') {
    return 'profile must be a custom profile, which sets one header for one host';
  }

  const parsedURL = typeof url === 'string' && URL.canParse(url) ? new URL(url) : null;

  if (
    parsedURL === null ||
    parsedURL.protocol !== 'https:' ||
    parsedURL.port !== '' ||
    parsedURL.username !== '' ||
    parsedURL.password !== ''
  ) {
    return 'url must be an https URL with no port and no user info';
  }

  if (parsedURL.hostname !== profile.host) {
    return `url must be on ${profile.host}, the host profile ${profileName} sends its credential to`;
  }

  return { name: options.name, url: parsedURL.href, profile: profileName, header: profile.header };
}
