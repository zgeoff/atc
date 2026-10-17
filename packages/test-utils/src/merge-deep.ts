import type { MockOverrides } from './mock-overrides';

export function mergeDeep<T extends object, K extends keyof T = keyof T>(
  defaults: T,
  overrides: MockOverrides<T, K>,
): T {
  // oxlint-disable-next-line no-unsafe-type-assertion -- merging a deep partial of T over a whole T yields a whole T
  return mergeRecords(defaults, overrides) as T;
}

function mergeRecords(base: object, patch: object): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];

    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? mergeRecords(current, value) : value;
  }

  return merged;
}

function isPlainObject(value: unknown): value is object {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
