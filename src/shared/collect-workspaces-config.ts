import { DEFAULT_GIT_TRANSPORTS } from './default-git-transports';
import { isRecord } from './report';

/**
 * Where workspace sources come from: the GitHub owner whose repositories
 * the spawn picker lists by default, or null to list the gh account's own;
 * the ids of the sources the picker offers, in order, or null for the
 * default order; and the git transports the daemon fetches over.
 */
export interface WorkspacesConfig {
  readonly githubOwner: string | null;
  readonly sources: readonly string[] | null;
  readonly gitTransports: readonly string[] | InvalidGitTransports;
}

/**
 * A transport list the config holds that atc cannot use, with the config
 * errors it raised. The daemon runs no git while the list is invalid.
 */
export interface InvalidGitTransports {
  readonly invalid: string;
}

interface CollectedWorkspacesConfig {
  readonly workspaces: WorkspacesConfig;

  // The config problems the section holds, one line each.
  readonly errors: readonly string[];
}

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

/**
 * Reads the `workspaces` section of config.json. An owner that is not a
 * GitHub login is dropped, so a typo lists the gh account's own
 * repositories instead of failing, and a source order that is not a list
 * of ids falls back to the default order. A transport list that is not a
 * list of transports atc allows is a config error, and the list is then
 * invalid, never the default, so the daemon runs no git until it is fixed.
 * An empty list is valid and allows no transport.
 */
export function collectWorkspacesConfig(raw: unknown): CollectedWorkspacesConfig {
  const owner = isRecord(raw) ? raw['githubOwner'] : undefined;
  const sources = isRecord(raw) ? raw['sources'] : undefined;
  const rawTransports = isRecord(raw) ? raw['gitTransports'] : undefined;
  const transports = collectGitTransports(rawTransports);

  return {
    workspaces: {
      githubOwner: typeof owner === 'string' && GITHUB_OWNER_PATTERN.test(owner) ? owner : null,
      sources:
        Array.isArray(sources) &&
        sources.every((id): id is string => typeof id === 'string' && id !== '')
          ? sources
          : null,
      gitTransports: transports.transports,
    },
    errors: transports.errors,
  };
}

// The git transports a config may allow: the defaults, and the two
// opt-ins.
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set(['https', 'ssh', 'http', 'file']);

// Transports that run a command or read a descriptor on the daemon's host.
const REFUSED_TRANSPORTS: ReadonlySet<string> = new Set(['ext', 'fd']);

function collectGitTransports(raw: unknown): {
  readonly transports: readonly string[] | InvalidGitTransports;
  readonly errors: readonly string[];
} {
  if (raw === undefined) {
    return { transports: DEFAULT_GIT_TRANSPORTS, errors: [] };
  }

  const fallback = 'the daemon runs no git until it is fixed';

  if (!Array.isArray(raw)) {
    const error = `workspaces.gitTransports is not a list of git transports; ${fallback}`;

    return { transports: { invalid: error }, errors: [error] };
  }

  const errors = raw.flatMap((name: unknown) => {
    if (typeof name === 'string' && REFUSED_TRANSPORTS.has(name)) {
      return [
        `workspaces.gitTransports holds '${name}', which atc never allows because it runs a command or reads a descriptor on the daemon host; ${fallback}`,
      ];
    }

    if (typeof name !== 'string' || !KNOWN_TRANSPORTS.has(name)) {
      return [
        `workspaces.gitTransports holds ${JSON.stringify(name)}, which is not a git transport atc allows; ${fallback}`,
      ];
    }

    return [];
  });

  return errors.length === 0
    ? { transports: raw.filter((name): name is string => typeof name === 'string'), errors }
    : { transports: { invalid: errors.join('; ') }, errors };
}
