import {
  BROKER_PLACEHOLDER,
  isBrokerVariable,
  isRecord,
  isSubscriptionOverrideVariable,
} from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';

interface AuthProfiles {
  readonly profiles: ReadonlyMap<string, AuthProfile>;
  readonly errors: readonly string[];
}

export function collectAuthProfiles(raw: unknown): AuthProfiles {
  if (raw === undefined) {
    return { profiles: new Map(), errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return { profiles: new Map(), errors: ['authProfiles must be an object of named profiles'] };
  }

  const profiles = new Map<string, AuthProfile>();

  const errors: string[] = [];

  for (const [name, entry] of Object.entries(raw)) {
    const parsed = parseAuthProfile(name, entry);

    if (typeof parsed === 'string') {
      errors.push(`authProfiles.${name}: ${parsed}`);
    } else {
      profiles.set(name, parsed);
    }
  }

  return { profiles, errors };
}

// A lowercase hostname as a CONNECT carries it, with no port and no
// wildcard, whose last label starts with a letter so an IP address never
// matches.
const BROKER_HOST = /^(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/u;
const BROKER_HOST_MAX = 253;

// The profile an entry holds, or the first rule it breaks.
function parseAuthProfile(name: string, entry: unknown): AuthProfile | string {
  if (!isRecord(entry) || Array.isArray(entry)) {
    return 'a profile must be an object';
  }

  const secret = entry['secret'];
  const host = entry['host'];
  const header = entry['header'];
  const scheme = entry['scheme'];
  const dependencies = entry['dependencies'];
  const kind = entry['kind'] ?? 'custom';

  if (kind !== 'custom' && kind !== 'oauth' && kind !== 'github') {
    return 'kind must be custom, oauth, or github, the kinds atc binds';
  }

  if (typeof secret !== 'string' || secret === '') {
    return 'secret must be the name of a broker secret';
  }

  if (
    dependencies !== undefined &&
    (!Array.isArray(dependencies) || !dependencies.every((dep) => typeof dep === 'string'))
  ) {
    return 'dependencies must be an array of profile names';
  }

  if (kind === 'github') {
    const extra = ['host', 'header', 'scheme', 'user'].find((key) => entry[key] !== undefined);

    if (extra !== undefined) {
      return `${extra} cannot be set on a github profile, whose hosts and headers the broker's github secret fixes`;
    }

    if (entry['env'] !== undefined) {
      return "env cannot be set on a github profile, whose placeholders the broker's github secret sets";
    }

    return { name, secret, kind, env: {}, dependencies: dependencies ?? [] };
  }

  if (typeof host !== 'string' || host.length > BROKER_HOST_MAX || !BROKER_HOST.test(host)) {
    return 'host must be a lowercase hostname such as api.example.com';
  }

  if (typeof header !== 'string' || header === '') {
    return 'header must be a header name such as authorization';
  }

  if (scheme !== 'bearer' && scheme !== 'raw') {
    return 'scheme must be bearer or raw, the schemes atc binds';
  }

  if (entry['user'] !== undefined) {
    return 'user pairs only with the basic scheme, which atc does not bind';
  }

  const env = parseProfileEnv(entry['env'], host);

  if (typeof env === 'string') {
    return env;
  }

  return {
    name,
    secret,
    kind,
    host,
    header,
    scheme,
    env,
    dependencies: dependencies ?? [],
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function parseProfileEnv(raw: unknown, host: string): Record<string, string> | string {
  if (raw === undefined) {
    return {};
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return 'env must be an object of variable names';
  }

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(key)) {
      return `env.${key} is not a variable name: use capital letters, digits and underscores`;
    }

    if (isReservedEnvName(key)) {
      return `env.${key} cannot be set: atc or the broker sets or reserves it`;
    }

    // only the placeholder the broker swaps a credential in for, or the
    // profile's own host as an https origin, so a credential is never
    // written into a profile
    if (value !== BROKER_PLACEHOLDER && value !== `https://${host}`) {
      return `env.${key} must be ${BROKER_PLACEHOLDER} or https://${host}`;
    }

    env[key] = value;
  }

  return env;
}

const RESERVED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'ATC_', 'CODEX_', 'OPENAI_'];

const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set(['PATH', 'HOME']);

function isReservedEnvName(key: string): boolean {
  return (
    isBrokerVariable(key) ||
    isSubscriptionOverrideVariable(key) ||
    RESERVED_ENV_NAMES.has(key) ||
    RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
