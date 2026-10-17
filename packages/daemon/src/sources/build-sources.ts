import type { SourceProvider } from '@atc/plugin-api';

// The order sources take when the config gives none.
const DEFAULT_SOURCE_ORDER = ['dirs', 'github', 'git'];

interface BuiltSources {
  readonly sources: readonly SourceProvider[];

  // The ids a configured order holds that no available source has.
  readonly missing: readonly string[];
}

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
