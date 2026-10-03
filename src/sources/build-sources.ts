import type { SourceProvider } from './types';

// The order sources take when the config gives none.
const DEFAULT_SOURCE_ORDER = ['dirs', 'github', 'git'];

interface BuiltSources {
  readonly sources: readonly SourceProvider[];

  // The ids a configured order holds that no available source has.
  readonly missing: readonly string[];
}

/**
 * The sources the spawn picker offers, in the configured order, else the
 * default one. A source the order leaves out is not offered, and an id
 * with no available source is skipped, so a source that cannot run on
 * this host is simply not offered; a configured order reports such ids as
 * missing.
 */
export function buildSources(
  available: readonly SourceProvider[],
  order: readonly string[] | null,
): BuiltSources {
  const byID = new Map(available.map((source) => [source.id, source]));

  const sources: SourceProvider[] = [];
  const missing: string[] = [];

  for (const id of new Set(order ?? DEFAULT_SOURCE_ORDER)) {
    const source = byID.get(id);

    if (source !== undefined) {
      sources.push(source);
    } else if (order !== null) {
      missing.push(id);
    }
  }

  return { sources, missing };
}
