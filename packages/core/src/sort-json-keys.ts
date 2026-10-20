import { isRecord } from './is-record';

// code-unit order never ties two distinct keys, as a locale comparison can for
// two spellings of one accented letter. A stored hash keeps the order it was
// written with.
export type JSONKeyOrder = 'locale' | 'code-unit';

export function sortJSONKeys(value: unknown, order: JSONKeyOrder): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJSONKeys(item, order));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([leftKey], [rightKey]) =>
          order === 'locale'
            ? leftKey.localeCompare(rightKey)
            : Number(leftKey > rightKey) - Number(leftKey < rightKey),
        )
        .map(([key, item]) => [key, sortJSONKeys(item, order)]),
    );
  }

  return value;
}
