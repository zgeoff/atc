import { isRecord } from './report';

interface PrincipalsConfig {
  // The targets each principal may use, by principal; null when the config
  // has no `principals` key.
  readonly principals: ReadonlyMap<string, readonly string[]> | null;
  readonly errors: readonly string[];
}

/**
 * Reads the `principals` map: each principal's id to the names of the
 * targets it may use. No `principals` key is null. Otherwise the config
 * fails closed: a malformed map grants nothing to anyone, and a malformed
 * entry grants nothing to its principal. Each problem is an error.
 */
export function collectPrincipals(raw: unknown): PrincipalsConfig {
  if (raw === undefined) {
    return { principals: null, errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return {
      principals: new Map(),
      errors: ['principals must be an object of principal ids, so no principal gets a target'],
    };
  }

  const principals = new Map<string, readonly string[]>();

  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const targets = isRecord(entry) ? entry['targets'] : undefined;

    if (
      id === '' ||
      !Array.isArray(targets) ||
      !targets.every((target) => typeof target === 'string' && target !== '')
    ) {
      errors.push(
        `principal ${JSON.stringify(id)} must be an object whose targets is an array of target names, so it gets no target`,
      );

      continue;
    }

    principals.set(id, targets);
  }

  return { principals, errors };
}
