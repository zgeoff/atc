import type { AuthProfile } from '@atc/plugin-api';

interface AuthRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'bearer' | 'raw';
}

export interface ResolvedAuthSecret {
  readonly secret: string;
  readonly kind: AuthProfile['kind'];

  // empty for a github secret, whose rules the broker holds.
  readonly rules: readonly AuthRule[];
}

interface ResolvedAuthProfiles {
  readonly profiles: readonly string[];
  readonly hosts: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
  readonly env: Readonly<Record<string, string>>;
  readonly envOwners: Readonly<Record<string, string>>;
}

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

// each host must get exactly one rule, so a credential is never picked by
// order.
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

  const ordered = [...reached.values()].toSorted((left, right) =>
    left.name < right.name ? -1 : 1,
  );

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
      secrets: buildSecrets(ordered, [...byHost.values()]),
      env,
      envOwners,
    },
  };
}

// depth-first: a profile is added once its dependencies are done, and one
// already reached is not walked again; `path` holds the names on the way
// here, so a name already on it closes a cycle.
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

// The rules atc holds for a profile's secret on the hosts it covers. A
// github profile holds none: the broker's github secret brings its own.
function getProfileRules(profile: AuthProfile): readonly AuthRule[] {
  if (profile.kind === 'github') {
    return [];
  }

  return [{ host: profile.host, header: profile.header, scheme: profile.scheme }];
}

function hasSameRule(left: ProfileRule, right: ProfileRule): boolean {
  return (
    left.profile.secret === right.profile.secret &&
    left.profile.kind === right.profile.kind &&
    left.rule.header === right.rule.header &&
    left.rule.scheme === right.rule.scheme
  );
}

// One entry per secret, sorted by secret, each with its rules sorted by host.
// A secret whose profiles hold no rule, as a github secret's do, has an
// entry with none.
function buildSecrets(
  profiles: readonly AuthProfile[],
  entries: readonly ProfileRule[],
): ResolvedAuthSecret[] {
  const bySecret = new Map<string, { kind: AuthProfile['kind']; rules: AuthRule[] }>(
    profiles.map((profile) => [profile.secret, { kind: profile.kind, rules: [] }]),
  );

  for (const item of entries) {
    bySecret.get(item.profile.secret)?.rules.push(item.rule);
  }

  return [...bySecret.entries()]
    .toSorted(([leftSecret], [rightSecret]) => (leftSecret < rightSecret ? -1 : 1))
    .map(([secret, entry]) => ({
      secret,
      kind: entry.kind,
      rules: entry.rules.toSorted((leftRule, rightRule) =>
        leftRule.host < rightRule.host ? -1 : 1,
      ),
    }));
}
