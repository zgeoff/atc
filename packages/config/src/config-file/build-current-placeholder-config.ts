import { BROKER_PLACEHOLDER, isRecord } from '@atc/core';

// A deprecated placeholder, which atc reads as its own and warns about.
export const LEGACY_BROKER_PLACEHOLDER = 'imp-broker-placeholder';

// The fields that hold a credential's placeholder, `*` matching any key; the
// gateways key is the one the config migration reads.
const PLACEHOLDER_FIELDS: readonly (readonly string[])[] = [
  ['authProfiles', '*', 'env', '*'],
  ['agents', '*', 'auth', 'placeholderEnv', '*'],
  ['gateways', '*', 'auth', 'placeholderEnv', '*'],
];

interface PlaceholderReplacement {
  readonly config: Record<string, unknown>;

  // one line for the whole file, or null when it holds no old value.
  readonly warning: string | null;
}

export function buildCurrentPlaceholderConfig(
  config: Readonly<Record<string, unknown>>,
): PlaceholderReplacement {
  let found = false;

  const onFound = (): void => {
    found = true;
  };

  const current: Record<string, unknown> = { ...config };

  for (const [key, ...rest] of PLACEHOLDER_FIELDS) {
    if (key !== undefined && Object.hasOwn(current, key)) {
      current[key] = buildCurrentField(current[key], rest, onFound);
    }
  }

  return {
    config: current,
    warning: found
      ? `config.json holds the placeholder ${LEGACY_BROKER_PLACEHOLDER}, which atc reads as ${BROKER_PLACEHOLDER}; write ${BROKER_PLACEHOLDER} instead, since a later release stops reading the old value`
      : null,
  };
}

function buildCurrentField(value: unknown, path: readonly string[], onFound: () => void): unknown {
  const [key, ...rest] = path;

  if (key === undefined) {
    if (value !== LEGACY_BROKER_PLACEHOLDER) {
      return value;
    }

    onFound();

    return BROKER_PLACEHOLDER;
  }

  if (!isRecord(value) || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      key === '*' || key === name ? buildCurrentField(item, rest, onFound) : item,
    ]),
  );
}
