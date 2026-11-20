import { isRecord } from '@atc/core';
import { FEATURE_INPUT_FIELDS } from '@atcx/contract/light';

interface MissingFeature {
  readonly field: string;
  readonly feature: string;
}

// Finds the first input field of a call that the daemon's features do not cover: a field that is
// present and not undefined, listed for the method, whose feature the hello answer lacks.
export function findMissingFeature(
  method: string,
  input: unknown,
  features: readonly string[],
): MissingFeature | null {
  const listed: Readonly<Record<string, Readonly<Record<string, string>>>> = FEATURE_INPUT_FIELDS;
  const fields = listed[method];

  if (fields === undefined) {
    return null;
  }

  for (const [field, feature] of Object.entries(fields)) {
    if (findPathValue(input, field.split('.')) !== undefined && !features.includes(feature)) {
      return { field, feature };
    }
  }

  return null;
}

function findPathValue(value: unknown, path: readonly string[]): unknown {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}
