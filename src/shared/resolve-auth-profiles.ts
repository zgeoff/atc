import type { AuthProfile } from './collect-auth-profiles';

/**
 * How impd applies one secret to requests for one host. Only a basic rule
 * holds a user.
 */
interface AuthRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'basic' | 'bearer';
  readonly user?: string;
}

/**
 * One secret and the complete set of rules a selection needs impd to hold
 * for it, one per host, sorted by host.
 */
export interface ResolvedAuthSecret {
  readonly secret: string;
  readonly kind: AuthProfile['kind'];
  readonly rules: readonly AuthRule[];
}

/**
 * A selection with its dependencies expanded: every profile it reaches,
 * every host those profiles send a credential to, the variables they set
 * in the guest with the profile each came from, and the rules grouped by
 * secret, each list sorted so two selections of the same profiles resolve
 * the same.
 */
interface ResolvedAuthProfiles {
  readonly profiles: readonly string[];
  readonly hosts: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
  readonly env: Readonly<Record<string, string>>;
  readonly envOwners: Readonly<Record<string, string>>;
}

/**
 * Why a selection cannot be bound:
 *
 * - `auth_profile_unknown`: it reaches a profile that is missing or that
 *   the config refused.
 * - `auth_dependency_cycle`: the dependencies loop back on themselves.
 * - `auth_collision`: two profiles send different credentials or rules to
 *   one host, which impd could not tell apart, or set one variable to
 *   different values.
 */
export interface AuthProfileProblem {
  readonly code: 'auth_profile_unknown' | 'auth_dependency_cycle' | 'auth_collision';
  readonly message: string;
}

export type AuthProfileResolution =
  | { readonly resolved: ResolvedAuthProfiles }
  | { readonly problem: AuthProfileProblem };

// One rule of a profile, with the profile it came from.
interface ProfileRule {
  readonly profile: AuthProfile;
  readonly rule: AuthRule;
}

/**
 * Expands the selected profiles through their dependencies, then checks
 * the whole expanded set: each host must get exactly one rule, so a
 * credential is never picked by order, and each secret one kind. Two
 * profiles holding the identical secret and rule for a host merge into one
 * rule.
 */
export function resolveAuthProfiles(
  profiles: ReadonlyMap<string, AuthProfile>,
  selected: readonly string[],
): AuthProfileResolution {
  let reached: ReadonlyMap<string, AuthProfile> = new Map();

  for (const name of selected) {
    const next = collectReached(profiles, name, null, [], reached);

    if (isAuthProfileProblem(next)) {
      return { problem: next };
    }

    reached = next;
  }

  const ordered = [...reached.values()].toSorted((a, b) => (a.name < b.name ? -1 : 1));

  const byHost = new Map<string, ProfileRule>();
  const kinds = new Map<string, AuthProfile>();

  const env: Record<string, string> = {};
  const envOwners: Record<string, string> = {};

  for (const profile of ordered) {
    const kindOwner = kinds.get(profile.secret);

    if (kindOwner === undefined) {
      kinds.set(profile.secret, profile);
    } else if (kindOwner.kind !== profile.kind) {
      return {
        problem: {
          code: 'auth_collision',
          message: `profiles ${kindOwner.name} and ${profile.name} bind secret ${profile.secret} as different kinds`,
        },
      };
    }

    for (const [key, value] of Object.entries(profile.env)) {
      const owner = envOwners[key];

      if (owner === undefined) {
        env[key] = value;
        envOwners[key] = profile.name;
      } else if (env[key] !== value) {
        return {
          problem: {
            code: 'auth_collision',
            message: `profiles ${owner} and ${profile.name} set ${key} to different values`,
          },
        };
      }
    }

    for (const rule of getProfileRules(profile)) {
      const other = byHost.get(rule.host);

      if (other === undefined) {
        byHost.set(rule.host, { profile, rule });
      } else if (!hasSameRule(other, { profile, rule })) {
        return {
          problem: {
            code: 'auth_collision',
            message: `profiles ${other.profile.name} and ${profile.name} both send a credential to ${rule.host}`,
          },
        };
      }
    }
  }

  return {
    resolved: {
      profiles: ordered.map((profile) => profile.name),
      hosts: [...byHost.keys()].toSorted(),
      secrets: buildSecrets([...byHost.values()]),
      env,
      envOwners,
    },
  };
}

// Depth-first over the dependencies from one name: returns `reached` plus
// every profile this name reaches, each added once its own dependencies are
// done. A profile already reached is not walked again, so a shared
// dependency costs one visit.
// `path` holds the names on the way here, so a name already on it closes a
// cycle.
function collectReached(
  profiles: ReadonlyMap<string, AuthProfile>,
  name: string,
  from: string | null,
  path: readonly string[],
  reached: ReadonlyMap<string, AuthProfile>,
): ReadonlyMap<string, AuthProfile> | AuthProfileProblem {
  if (path.includes(name)) {
    return {
      code: 'auth_dependency_cycle',
      message: `profile dependencies form a cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`,
    };
  }

  if (reached.has(name)) {
    return reached;
  }

  const profile = profiles.get(name);

  if (profile === undefined) {
    return {
      code: 'auth_profile_unknown',
      message:
        from === null
          ? `profile ${name} is selected, but authProfiles has no usable profile by that name`
          : `profile ${from} depends on ${name}, but authProfiles has no usable profile by that name`,
    };
  }

  let next = reached;

  for (const dependency of profile.dependencies) {
    const after = collectReached(profiles, dependency, name, [...path, name], next);

    if (isAuthProfileProblem(after)) {
      return after;
    }

    next = after;
  }

  return new Map([...next, [name, profile]]);
}

function isAuthProfileProblem(
  value: ReadonlyMap<string, AuthProfile> | AuthProfileProblem,
): value is AuthProfileProblem {
  return 'code' in value;
}

// The rules impd's github kind applies: git over HTTPS on github.com takes
// Basic auth for x-access-token, and the REST and upload APIs take a bearer
// token.
const GITHUB_RULES: readonly AuthRule[] = [
  { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
  { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
  { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
];

// The rules impd holds for a profile's secret on the hosts it covers.
function getProfileRules(profile: AuthProfile): readonly AuthRule[] {
  if (profile.kind === 'github') {
    return GITHUB_RULES;
  }

  return [{ host: profile.host, header: profile.header, scheme: profile.scheme }];
}

function hasSameRule(left: ProfileRule, right: ProfileRule): boolean {
  return (
    left.profile.secret === right.profile.secret &&
    left.profile.kind === right.profile.kind &&
    left.rule.header === right.rule.header &&
    left.rule.scheme === right.rule.scheme &&
    left.rule.user === right.rule.user
  );
}

// One entry per secret, sorted by secret, each with its rules sorted by host.
function buildSecrets(entries: readonly ProfileRule[]): ResolvedAuthSecret[] {
  const bySecret = new Map<string, { kind: AuthProfile['kind']; rules: AuthRule[] }>();

  for (const item of entries) {
    const entry = bySecret.get(item.profile.secret) ?? { kind: item.profile.kind, rules: [] };

    entry.rules.push(item.rule);
    bySecret.set(item.profile.secret, entry);
  }

  return [...bySecret.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([secret, entry]) => ({
      secret,
      kind: entry.kind,
      rules: entry.rules.toSorted((a, b) => (a.host < b.host ? -1 : 1)),
    }));
}
