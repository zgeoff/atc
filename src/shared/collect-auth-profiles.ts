import { isRecord } from './report';

/**
 * A named reference to a credential impd holds: the secret's name, never
 * its value, and the profiles a session selecting this one needs beside
 * it. A `custom` profile holds the one rule impd applies when a request
 * reaches its host, always a bearer header. A `github` profile holds no
 * rule: impd's `github` kind fixes its hosts and headers.
 */
export type AuthProfile = CustomAuthProfile | GitHubAuthProfile;

interface CustomAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'custom';
  readonly host: string;
  readonly header: string;
  readonly scheme: 'bearer';
  readonly dependencies: readonly string[];
}

interface GitHubAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'github';
  readonly dependencies: readonly string[];
}

interface AuthProfiles {
  readonly profiles: ReadonlyMap<string, AuthProfile>;
  readonly errors: readonly string[];
}

/**
 * Reads the `authProfiles` map under impd's own rules for secret names,
 * broker hosts and header names. A profile that breaks a rule is left out
 * with an error, so a gateway that selects it is refused rather than bound
 * to a rule impd would reject or apply differently. Dependencies are
 * names only here; whether they resolve is a property of each selection.
 */
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

// impd's secret name rule: an imp name's form, so a secret name is never a
// path or a flag.
const SECRET_NAME = /^[a-z][a-z0-9-]{0,30}$/;

// impd's broker host rule: a lowercase hostname as a CONNECT carries it, with
// no port and no wildcard, whose last label starts with a letter so an IP
// address never matches.
const BROKER_HOST = /^(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/;
const BROKER_HOST_MAX = 253;

// impd's header name rule.
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

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

  if (kind !== 'custom' && kind !== 'github') {
    return 'kind must be custom or github, the kinds atc binds';
  }

  if (typeof secret !== 'string' || !SECRET_NAME.test(secret)) {
    return 'secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens';
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
      return `${extra} cannot be set on a github profile, whose hosts and headers impd's github kind fixes`;
    }

    return { name, secret, kind, dependencies: dependencies ?? [] };
  }

  if (typeof host !== 'string' || host.length > BROKER_HOST_MAX || !BROKER_HOST.test(host)) {
    return 'host must be a lowercase hostname such as api.example.com';
  }

  if (typeof header !== 'string' || !HEADER_NAME.test(header)) {
    return 'header must be a lowercase header name such as authorization';
  }

  if (scheme !== 'bearer') {
    return 'scheme must be bearer, the one scheme atc binds';
  }

  if (entry['user'] !== undefined) {
    return 'user pairs only with the basic scheme, which atc does not bind';
  }

  return {
    name,
    secret,
    kind: 'custom',
    host,
    header,
    scheme,
    dependencies: dependencies ?? [],
  };
}
