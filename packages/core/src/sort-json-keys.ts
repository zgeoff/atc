import { isRecord } from './is-record';

/**
 * The key order a canonical form uses. `locale` compares with
 * `localeCompare`; `code-unit` compares UTF-16 code units, which never ties
 * two distinct keys, as a locale comparison can for two spellings of one
 * accented letter. A stored hash keeps the order it was written with.
 */
export type JSONKeyOrder = 'locale' | 'code-unit';

/**
 * Returns a JSON value with every object's keys in the given order, at every
 * depth, so two values that differ only in key order serialize the same.
 */
export function sortJSONKeys(value: unknown, order: JSONKeyOrder): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJSONKeys(item, order));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) =>
          order === 'locale' ? a.localeCompare(b) : Number(a > b) - Number(a < b),
        )
        .map(([key, item]) => [key, sortJSONKeys(item, order)]),
    );
  }

  return value;
}
