import type { AuthProfile } from './collect-auth-profiles';
import { isRecord } from './report';
import { resolveAuthProfiles } from './resolve-auth-profiles';

/**
 * An MCP server a stock Claude session on a target that reaches impd's
 * broker reaches over HTTP, with the header that one of the session's
 * profiles sets for the server's host. The session sends a placeholder in
 * that header, and impd swaps the credential in on the host's side.
 */
export interface ClaudeMCPServer {
  readonly name: string;
  readonly url: string;
  readonly profile: string;
  readonly header: string;
}

/**
 * The profiles a stock Claude session on a target that reaches impd's
 * broker signs in through: one of them sends the subscription's setup
 * token to the Anthropic API as a bearer authorization header, and the
 * rest bind beside it, such as a GitHub token or an MCP server's key.
 */
interface ClaudeAuth {
  readonly profiles: readonly string[];
  readonly mcpServers: readonly ClaudeMCPServer[];
}

interface CollectedClaudeAuth {
  readonly auth: ClaudeAuth | null;
  readonly errors: readonly string[];
}

/**
 * Reads a Claude subscription auth entry against the auth profiles, `field`
 * being the key it was set under in error text. An entry that
 * does not resolve, or whose profiles send no bearer authorization header
 * to the Anthropic API, is left out with every problem that refused it, so
 * stock Claude keeps the sign-in of the host it runs on rather than binding
 * a credential the CLI would never send. An MCP server that breaks a rule
 * is left out alone, with an error, and the sign-in stays.
 */
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

  const extra = Object.keys(raw).find((key) => key !== 'profiles' && key !== 'mcpServers');

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
    .find((r) => r.host === ANTHROPIC_API_HOST);

  if (rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
    return {
      auth: null,
      errors: [
        `${field} needs a profile that sets a bearer authorization header for ${ANTHROPIC_API_HOST}, where Claude Code sends its subscription token`,
      ],
    };
  }

  const servers = collectMCPServers(raw['mcpServers'], field, selected, authProfiles);

  return { auth: { profiles: selected, mcpServers: servers.servers }, errors: servers.errors };
}

// The one host Claude Code sends a subscription token to.
const ANTHROPIC_API_HOST = 'api.anthropic.com';

interface CollectedMCPServers {
  readonly servers: readonly ClaudeMCPServer[];
  readonly errors: readonly string[];
}

// Reads the `mcpServers` map, server names to the server's URL and the
// selected profile that carries its credential.
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
    const parsed = parseMCPServer(name, entry, field, selected, authProfiles);

    if (typeof parsed === 'string') {
      errors.push(`${field}.mcpServers.${name}: ${parsed}`);
    } else {
      servers.push(parsed);
    }
  }

  return { servers, errors };
}

// Claude Code's rule for an MCP server's name.
const MCP_SERVER_NAME = /^[\w-]{1,64}$/u;

// The server an entry holds, or the first rule it breaks. The header comes
// from the profile, so the header the session sends and the one impd swaps
// the credential into never differ.
function parseMCPServer(
  name: string,
  entry: unknown,
  field: string,
  selected: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile>,
): ClaudeMCPServer | string {
  if (!MCP_SERVER_NAME.test(name)) {
    return 'a server name must be letters, digits, underscores or hyphens';
  }

  if (!isRecord(entry) || Array.isArray(entry)) {
    return 'a server must be an object with url and profile';
  }

  const extra = Object.keys(entry).find((key) => key !== 'url' && key !== 'profile');

  if (extra !== undefined) {
    return `${extra} cannot be set: atc fixes the transport and the placeholder header`;
  }

  const url = entry['url'];
  const profileName = entry['profile'];

  if (typeof profileName !== 'string' || !selected.includes(profileName)) {
    return `profile must be one of ${field}.profiles`;
  }

  const profile = authProfiles.get(profileName);

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

  return { name, url: parsedURL.href, profile: profileName, header: profile.header };
}
