import { firstPartyScopes } from './first-party-scopes.ts';
import type { AgeGate } from './parse-age-gate.ts';
import type { DependencyGateFinding } from './types.ts';

// An exclude with a version, such as `@zgeoff/std@1.0.0`, lets only that release through, so it
// does not count.
export function collectMissingFirstPartyExcludes(
  ageGate: AgeGate,
  registryNames: readonly string[],
): DependencyGateFinding[] {
  if (!ageGate.isOn) {
    return [];
  }

  return registryNames
    .filter((name) => firstPartyScopes.some((scope) => name.startsWith(scope)))
    .filter((name) => !ageGate.excludes.includes(name))
    .map((name) => ({
      path: 'bunfig.toml',
      entry: name,
      problem:
        'the first-party package has no age-gate exclude, so bun install refuses each release younger than the gate',
    }));
}
