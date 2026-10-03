import { isRecord } from './report';

/**
 * Where workspace sources come from and where their checkouts land: the
 * GitHub owner whose repositories the spawn picker lists by default, or
 * null to list the gh account's own; the root a checkout lands under on
 * any target without its own, or null for the default; and each target's
 * own root, by target id. A root is kept as written: whether it fits its
 * target, such as `~` on a remote target, is checked where the target is
 * known.
 */
export interface WorkspacesConfig {
  readonly githubOwner: string | null;
  readonly root: string | null;
  readonly targetRoots: ReadonlyMap<string, string>;
}

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

/**
 * Reads the `workspaces` section of config.json. An owner that is not a
 * GitHub login is dropped, so a typo lists the gh account's own
 * repositories instead of failing, and a root that is not a non-empty
 * string is dropped too.
 */
export function collectWorkspacesConfig(raw: unknown): WorkspacesConfig {
  const section = isRecord(raw) ? raw : {};
  const owner = section['githubOwner'];
  const root = section['root'];
  const targets = isRecord(section['targets']) ? section['targets'] : {};

  return {
    githubOwner: typeof owner === 'string' && GITHUB_OWNER_PATTERN.test(owner) ? owner : null,
    root: typeof root === 'string' && root !== '' ? root : null,
    targetRoots: new Map(
      Object.entries(targets).flatMap(([id, dir]) =>
        typeof dir === 'string' && dir !== '' ? [[id, dir] as const] : [],
      ),
    ),
  };
}
