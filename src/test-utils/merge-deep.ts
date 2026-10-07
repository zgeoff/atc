import type { PartialDeep } from 'type-fest';

/**
 * A copy of the defaults with each override laid over it: a plain object
 * on both sides merges key by key at every depth, and any other value,
 * arrays and class instances included, replaces the default whole. Neither
 * argument changes. A mock factory passes its fresh defaults here, so a
 * nested override keeps every default beside it.
 */
export function mergeDeep<T extends object>(defaults: T, overrides: PartialDeep<T>): T {
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
