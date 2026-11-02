import { isRecord } from './is-record.ts';

export interface AgeGate {
  readonly isOn: boolean;
  readonly excludes: readonly string[];
}

export function parseAgeGate(bunfig: string): AgeGate {
  const parsed: unknown = Bun.TOML.parse(bunfig);
  const install = isRecord(parsed) ? parsed['install'] : undefined;
  const minimumReleaseAge = isRecord(install) ? install['minimumReleaseAge'] : undefined;
  const excludes = isRecord(install) ? install['minimumReleaseAgeExcludes'] : undefined;

  if (excludes !== undefined && !isStringList(excludes)) {
    throw new TypeError('bunfig.toml sets a minimumReleaseAgeExcludes that is not a list of names');
  }

  return {
    isOn: minimumReleaseAge !== undefined && minimumReleaseAge !== 0 && minimumReleaseAge !== '0',
    excludes: excludes ?? [],
  };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
