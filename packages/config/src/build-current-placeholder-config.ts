import { BROKER_PLACEHOLDER, isRecord } from '@atc/core';

// A deprecated placeholder, which atc reads as its own and warns about.
const LEGACY_PLACEHOLDER = 'imp-broker-placeholder';

interface PlaceholderReplacement {
  readonly config: unknown;

  // one line for the whole file, or null when it holds no old value.
  readonly warning: string | null;
}

export function buildCurrentPlaceholderConfig(config: unknown): PlaceholderReplacement {
  let found = false;

  const current = buildCurrentValue(config, () => {
    found = true;
  });

  return {
    config: current,
    warning: found
      ? `config.json holds the placeholder ${LEGACY_PLACEHOLDER}, which atc reads as ${BROKER_PLACEHOLDER}; write ${BROKER_PLACEHOLDER} instead, since a later release stops reading the old value`
      : null,
  };
}

// A copy of the value with each string that equals the old placeholder
// swapped for the current one.
function buildCurrentValue(value: unknown, onFound: () => void): unknown {
  if (value === LEGACY_PLACEHOLDER) {
    onFound();

    return BROKER_PLACEHOLDER;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => buildCurrentValue(item, onFound));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, buildCurrentValue(item, onFound)]),
    );
  }

  return value;
}
