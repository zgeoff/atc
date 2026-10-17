import { isRecord } from '@atc/core';

export function getRecords(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown>[] {
  const inner = value[key];

  if (!Array.isArray(inner) || !inner.every((item) => isRecord(item))) {
    throw new TypeError(`${key} is not an array of records`);
  }

  return inner;
}
