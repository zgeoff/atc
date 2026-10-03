import type { AuthProfile } from './collect-auth-profiles';

/**
 * How impd applies one secret to requests for one host.
 */
interface AuthRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'bearer';
}

/**
 * One secret and the complete set of rules a selection needs impd to hold
 * for it, one per host, sorted by host.
 */
export interface ResolvedAuthSecret {
  readonly secret: string;
  readonly kind: 'custom';
  readonly rules: readonly AuthRule[];
}

/**
 * A selection with its dependencies expanded: every profile it reaches,
 * every host those profiles send a credential to, and the rules grouped by
 * secret, each list sorted so two selections of the same profiles resolve
 * the same.
 */
interface ResolvedAuthProfiles {
  readonly profiles: readonly string[];
  readonly hosts: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
}

/**
 * Why a selection cannot be bound:
 *
 * - `auth_profile_unknown`: it reaches a profile that is missing or that
 *   the config refused.
 * - `auth_dependency_cycle`: the dependencies loop back on themselves.
 * - `auth_collision`: two profiles send different credentials or rules to
 *   one host, which impd could not tell apart.
 */
export interface AuthProfileProblem {
  readonly code: 'auth_profile_unknown' | 'auth_dependency_cycle' | 'auth_collision';
  readonly message: string;
}

export type AuthProfileResolution =
  | { readonly resolved: ResolvedAuthProfiles }
  | { readonly problem: AuthProfileProblem };

/**
 * Expands the selected profiles through their dependencies, then checks
 * the whole expanded set: each host must get exactly one rule, so a
 * credential is never picked by order. Two profiles holding the identical
 * secret and rule for a host merge into one rule.
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

  const byHost = new Map<string, AuthProfile>();

  for (const profile of ordered) {
    const other = byHost.get(profile.host);

    if (other === undefined) {
      byHost.set(profile.host, profile);
    } else if (!hasSameRule(other, profile)) {
      return {
        problem: {
          code: 'auth_collision',
          message: `profiles ${other.name} and ${profile.name} both send a credential to ${profile.host}`,
        },
      };
    }
  }

  return {
    resolved: {
      profiles: ordered.map((profile) => profile.name),
      hosts: [...byHost.keys()].toSorted(),
      secrets: buildSecrets([...byHost.values()]),
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

function hasSameRule(left: AuthProfile, right: AuthProfile): boolean {
  return (
    left.secret === right.secret &&
    left.header === right.header &&
    left.scheme === right.scheme &&
    left.kind === right.kind
  );
}

// One entry per secret, sorted by secret, each with its rules sorted by host.
function buildSecrets(profiles: readonly AuthProfile[]): ResolvedAuthSecret[] {
  const rules = new Map<string, AuthRule[]>();

  for (const profile of profiles) {
    const list = rules.get(profile.secret) ?? [];

    list.push({ host: profile.host, header: profile.header, scheme: profile.scheme });
    rules.set(profile.secret, list);
  }

  return [...rules.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([secret, list]) => ({
      secret,
      kind: 'custom',
      rules: list.toSorted((a, b) => (a.host < b.host ? -1 : 1)),
    }));
}
