import { pickDefaultTarget } from './pick-default-target';
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

interface TargetsConfig {
  readonly targets: readonly TargetConfig[];

  // The target a spawn without a target runs on; always one of the targets.
  readonly defaultTarget: string;

  // One line per config problem the parse fell back from.
  readonly warnings: readonly string[];
}

// The target every config holds when it sets no targets of its own: the
// daemon's own machine.
const LOCAL_TARGET: TargetConfig = { id: 'local', provider: 'local-pty', options: {} };

/**
 * Reads the `targets` map and `defaultTarget` into the targets sessions can
 * run on. No `targets` key holds the one implicit `local` target. A
 * malformed map, an empty map, or a map with any malformed entry holds only
 * `local`, with a warning: dropping just the bad entry could drop a
 * mistyped `local` and turn local sessions off unasked. A well-formed map
 * holds exactly its own entries, so one without `local` turns local
 * sessions off. A `defaultTarget` that matches no target falls back, with a
 * warning, to `local` when the map holds it and to the first entry
 * otherwise.
 */
export function collectTargets(rawTargets: unknown, rawDefault: unknown): TargetsConfig {
  const collected = collectTargetEntries(rawTargets);
  const targets = collected.targets;
  const warnings = collected.warning === null ? [] : [collected.warning];
  const requested = typeof rawDefault === 'string' ? rawDefault : undefined;

  const picked = pickDefaultTarget(
    targets.map((target) => target.id),
    requested,
  );

  if (rawDefault !== undefined && !picked.matched) {
    warnings.push(
      `defaultTarget ${JSON.stringify(rawDefault)} matches no configured target; using '${picked.id}'`,
    );
  }

  return { targets, defaultTarget: picked.id, warnings };
}

interface TargetEntries {
  readonly targets: readonly TargetConfig[];
  readonly warning: string | null;
}

function collectTargetEntries(raw: unknown): TargetEntries {
  if (raw === undefined) {
    return { targets: [LOCAL_TARGET], warning: null };
  }

  if (!isRecord(raw) || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return {
      targets: [LOCAL_TARGET],
      warning: "targets must be a non-empty object of named targets; using only 'local'",
    };
  }

  const targets: TargetConfig[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const provider = isRecord(entry) ? entry['provider'] : undefined;

    if (id === '' || !isRecord(entry) || typeof provider !== 'string' || provider === '') {
      return {
        targets: [LOCAL_TARGET],
        warning: `target ${JSON.stringify(id)} must be an object with a non-empty string provider; using only 'local'`,
      };
    }

    const { provider: _, ...options } = entry;

    targets.push({ id, provider, options });
  }

  return { targets, warning: null };
}
