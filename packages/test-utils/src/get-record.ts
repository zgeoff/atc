import { isRecord } from '@atc/core';

export function getRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const inner = value[key];

  if (!isRecord(inner)) {
    throw new TypeError(`${key} is not an object`);
  }

  return inner;
}
