import type { SQLQueryBindings } from 'bun:sqlite';

/**
 * A compiled kysely query's parameters, narrowed to what bun:sqlite accepts
 * for a bound statement. kysely's sqlite compiler only ever binds values
 * bun:sqlite itself accepts, even though it types the array as unknown[] to
 * stay dialect-agnostic; this is the one point where that is trusted.
 */
export function toSQLBindings(parameters: readonly unknown[]): SQLQueryBindings[] {
  // oxlint-disable-next-line no-unsafe-type-assertion -- kysely's sqlite compiler only ever binds bun:sqlite-legal values here; this is the one point where it is trusted
  return parameters as SQLQueryBindings[];
}
