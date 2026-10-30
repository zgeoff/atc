// The limits match the max-test-timeout rule in @zgeoff/oxlint-config, which CI cannot import: the
// workflow downloads this file and the modules it imports one by one.
const standardLaneLimits: readonly (readonly [string, number])[] = [
  ['browser', 10_000],
  ['e2e', 15_000],
  ['docker', 15_000],
  ['host', 15_000],
  ['agent-sdk', 5000],
  ['model-api', 120_000],
];

const listedLaneLimitMs = 15_000;

export function parseLaneLimits(configText: string | null): ReadonlyMap<string, number> {
  const limits = new Map(standardLaneLimits);

  const lanes = configText === null ? undefined : parseLanesOption(configText);

  if (Array.isArray(lanes)) {
    for (const lane of lanes) {
      if (typeof lane === 'string' && !limits.has(lane)) {
        limits.set(lane, listedLaneLimitMs);
      }
    }
  } else if (typeof lanes === 'object' && lanes !== null) {
    for (const [lane, limitMs] of Object.entries(lanes)) {
      if (typeof limitMs === 'number') {
        limits.set(lane, limitMs);
      }
    }
  }

  return limits;
}

function parseLanesOption(text: string): unknown {
  const config = parseConfig(text);
  const setting = findMember(findMember(config, 'rules'), 'zgeoff/max-test-timeout');
  const ruleOptions: unknown = Array.isArray(setting) ? setting[1] : undefined;

  return findMember(ruleOptions, 'lanes');
}

function parseConfig(text: string): unknown {
  try {
    return Bun.JSONC.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse .oxlintrc.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function findMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}
