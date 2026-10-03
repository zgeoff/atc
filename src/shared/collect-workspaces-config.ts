import { isRecord } from './report';

/**
 * Where workspace sources come from: the GitHub owner whose repositories
 * the spawn picker lists by default, or null to list the gh account's own,
 * and the ids of the sources the picker offers, in order, or null for the
 * default order.
 */
export interface WorkspacesConfig {
  readonly githubOwner: string | null;
  readonly sources: readonly string[] | null;
}

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

/**
 * Reads the `workspaces` section of config.json. An owner that is not a
 * GitHub login is dropped, so a typo lists the gh account's own
 * repositories instead of failing, and a source order that is not a list
 * of ids falls back to the default order.
 */
export function collectWorkspacesConfig(raw: unknown): WorkspacesConfig {
  const owner = isRecord(raw) ? raw['githubOwner'] : undefined;
  const sources = isRecord(raw) ? raw['sources'] : undefined;

  return {
    githubOwner: typeof owner === 'string' && GITHUB_OWNER_PATTERN.test(owner) ? owner : null,
    sources:
      Array.isArray(sources) &&
      sources.every((id): id is string => typeof id === 'string' && id !== '')
        ? sources
        : null,
  };
}
