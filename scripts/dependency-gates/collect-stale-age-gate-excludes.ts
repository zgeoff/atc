import assert from 'node:assert/strict';
import { firstPartyScopes } from './first-party-scopes.ts';
import { isRecord } from './is-record.ts';
import type { DependencyGateFinding } from './types.ts';

export function collectStaleAgeGateExcludes(
  bunfig: string,
  today: string,
): DependencyGateFinding[] {
  const removalDates = collectRemovalDates(bunfig);

  return parseAgeGateExcludes(bunfig)
    .filter((name) => !firstPartyScopes.some((scope) => name.startsWith(scope)))
    .flatMap((name) => {
      const removalDate = removalDates.get(name);

      if (removalDate === undefined) {
        return [
          {
            path: 'bunfig.toml',
            entry: name,
            problem: 'the age-gate exclude has no dated removal comment',
          },
        ];
      }

      if (removalDate < today) {
        return [
          {
            path: 'bunfig.toml',
            entry: name,
            problem: `the age-gate exclude was due for removal on ${removalDate}`,
          },
        ];
      }

      return [];
    });
}

// The shared audit-fix workflow writes this comment for each exclude it adds, and removes the
// exclude once the date passes.
const removalCommentPattern =
  /^# (?<name>\S+) \S+ \(published [^)]*\) ages past the gate ~(?<date>\d{4}-\d{2}-\d{2}) — remove then/gmu;

function collectRemovalDates(bunfig: string): Map<string, string> {
  const removalDates = new Map<string, string>();

  for (const match of bunfig.matchAll(removalCommentPattern)) {
    const name = match.groups?.['name'];
    const date = match.groups?.['date'];

    assert.ok(name !== undefined && date !== undefined, 'the removal comment pattern names both');

    const latest = removalDates.get(name);

    if (latest === undefined || date > latest) {
      removalDates.set(name, date);
    }
  }

  return removalDates;
}

function parseAgeGateExcludes(bunfig: string): string[] {
  const parsed: unknown = Bun.TOML.parse(bunfig);
  const install = isRecord(parsed) ? parsed['install'] : undefined;
  const excludes = isRecord(install) ? install['minimumReleaseAgeExcludes'] : undefined;

  if (excludes === undefined) {
    return [];
  }

  if (!isStringList(excludes)) {
    throw new TypeError('bunfig.toml sets a minimumReleaseAgeExcludes that is not a list of names');
  }

  return excludes;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
