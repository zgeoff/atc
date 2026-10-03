import { isRecord } from './report';

/**
 * Where workspace sources come from: the GitHub owner whose repositories
 * the spawn picker lists by default, or null to list the gh account's own.
 */
export interface WorkspacesConfig {
  readonly githubOwner: string | null;
}

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

/**
 * Reads the `workspaces` section of config.json. An owner that is not a
 * GitHub login is dropped, so a typo lists the gh account's own
 * repositories instead of failing.
 */
export function collectWorkspacesConfig(raw: unknown): WorkspacesConfig {
  const owner = isRecord(raw) ? raw['githubOwner'] : undefined;

  return {
    githubOwner: typeof owner === 'string' && GITHUB_OWNER_PATTERN.test(owner) ? owner : null,
  };
}
