import { GRANT_SCOPES } from '../shared/grant-scope';
import type { GrantScope } from '../shared/grant-scope';

/**
 * Reads an OAuth `scope` parameter: absent or empty asks for every scope, and
 * any value outside atc's four scopes makes the whole parameter invalid.
 */
export function parseScopeParam(raw: string | null): GrantScope[] | null {
  if (raw === null || raw.trim() === '') {
    return [...GRANT_SCOPES];
  }

  const requested = raw.split(' ').filter((value) => value !== '');
  const known = GRANT_SCOPES.filter((scope) => requested.includes(scope));

  if (requested.some((value) => !known.some((scope) => scope === value))) {
    return null;
  }

  return known;
}
