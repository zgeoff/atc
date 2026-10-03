import { isRecord } from '../shared/report';
import type { IDRule } from './id-rules';

// A value that holds one of atc's ids: a session id or daemon ID is a
// UUID, and a message id is a UUID behind `m-`.
const ID_PATTERN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/;

/**
 * The paths of every string in a daemon answer that holds an id but has no
 * rule, so a daemon field that starts carrying an id cannot leave the
 * gateway without its daemon's name. A ruled field and everything below a
 * ruled locator count as covered.
 */
export function collectUnruledIDPaths(
  value: unknown,
  rules: ReadonlyMap<string, IDRule>,
  path = '',
): string[] {
  const rule = rules.get(path);

  if (rule === 'locator' || (rule !== undefined && typeof value === 'string')) {
    return [];
  }

  if (typeof value === 'string') {
    return ID_PATTERN.test(value) ? [path] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => collectUnruledIDPaths(item, rules, `${path}[]`));
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, inner]) => {
      const innerPath = path === '' ? key : `${path}.${key}`;

      return collectUnruledIDPaths(inner, rules, innerPath);
    });
  }

  return [];
}
