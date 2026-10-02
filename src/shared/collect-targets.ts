import { isRecord } from './report';

/**
 * A named place sessions run: the execution provider kind that serves it,
 * and the options that kind takes.
 */
export interface TargetConfig {
  readonly id: string;
  readonly provider: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * A config problem that leaves a target, or every target, unusable: the
 * `targets` map as a whole, one entry of it, or `defaultTarget`.
 */
export interface TargetConfigError {
  readonly scope: 'targets' | 'target' | 'defaultTarget';

  // The entry the problem is in; present only for an entry's problem.
  readonly target?: string;
  readonly problem: string;
}

interface TargetsConfig {
  // Every well-formed entry, in config order.
  readonly targets: readonly TargetConfig[];

  // The target a spawn without a target runs on, or null when the config
  // gives none it can use.
  readonly defaultTarget: string | null;
  readonly errors: readonly TargetConfigError[];
}

// The target a config holds when it sets no targets of its own: the
// daemon's own machine.
const LOCAL_TARGET: TargetConfig = { id: 'local', provider: 'local-pty', options: {} };

/**
 * Reads the `targets` map and `defaultTarget`. No `targets` key holds the
 * one implicit `local` target as the default. Otherwise the config fails
 * closed: a malformed map holds no targets, a malformed entry is left out,
 * and a `defaultTarget` that is not a string or matches no well-formed
 * entry leaves no default. Each problem is an error, so a spawn that
 * resolves through it fails with that error instead of running on `local`.
 * Without `defaultTarget`, the default is the `local` entry when the map
 * holds a well-formed one, and none otherwise.
 */
export function collectTargets(rawTargets: unknown, rawDefault: unknown): TargetsConfig {
  if (rawTargets === undefined && rawDefault === undefined) {
    return { targets: [LOCAL_TARGET], defaultTarget: 'local', errors: [] };
  }

  const collected = collectTargetEntries(rawTargets);

  const ids = new Set(collected.targets.map((target) => target.id));

  if (rawDefault === undefined) {
    return {
      targets: collected.targets,
      defaultTarget: ids.has('local') ? 'local' : null,
      errors: collected.errors,
    };
  }

  if (typeof rawDefault === 'string' && ids.has(rawDefault)) {
    return { targets: collected.targets, defaultTarget: rawDefault, errors: collected.errors };
  }

  return {
    targets: collected.targets,
    defaultTarget: null,
    errors: [
      ...collected.errors,
      {
        scope: 'defaultTarget',
        problem: `defaultTarget ${JSON.stringify(rawDefault)} matches no well-formed target in targets`,
      },
    ],
  };
}

interface TargetEntries {
  readonly targets: readonly TargetConfig[];
  readonly errors: readonly TargetConfigError[];
}

function collectTargetEntries(raw: unknown): TargetEntries {
  // A defaultTarget without a targets map names one of the implicit targets.
  if (raw === undefined) {
    return { targets: [LOCAL_TARGET], errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return {
      targets: [],
      errors: [
        { scope: 'targets', problem: 'targets must be a non-empty object of named targets' },
      ],
    };
  }

  const targets: TargetConfig[] = [];
  const errors: TargetConfigError[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const provider = isRecord(entry) ? entry['provider'] : undefined;

    if (id === '' || !isRecord(entry) || typeof provider !== 'string' || provider === '') {
      errors.push({
        scope: 'target',
        target: id,
        problem: `target ${JSON.stringify(id)} must be an object with a non-empty string provider`,
      });

      continue;
    }

    const { provider: _, ...options } = entry;

    targets.push({ id, provider, options });
  }

  return { targets, errors };
}
