import { isRecord } from '@atc/core';
import { DEFAULT_GIT_TRANSPORTS } from './default-git-transports';

export interface InvalidGitTransports {
  readonly invalid: string;
}

// a root is kept as written; whether it fits its target, such as `~` on a
// remote target, is checked where the target is known.
export interface WorkspacesConfig {
  readonly githubOwner: string | null;
  readonly sources: readonly string[] | null;
  readonly gitTransports: readonly string[] | InvalidGitTransports;
  readonly root: string | null;
  readonly targetRoots: ReadonlyMap<string, string>;
}

interface CollectedWorkspacesConfig {
  readonly workspaces: WorkspacesConfig;

  // The config problems the section holds, one line each.
  readonly errors: readonly string[];
}

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

export function collectWorkspacesConfig(raw: unknown): CollectedWorkspacesConfig {
  const section = isRecord(raw) ? raw : {};
  const owner = section['githubOwner'];
  const sources = section['sources'];
  const root = section['root'];
  const targets = isRecord(section['targets']) ? section['targets'] : {};
  const transports = collectGitTransports(section['gitTransports']);

  return {
    workspaces: {
      githubOwner: typeof owner === 'string' && GITHUB_OWNER_PATTERN.test(owner) ? owner : null,
      sources:
        Array.isArray(sources) &&
        sources.every((id): id is string => typeof id === 'string' && id !== '')
          ? sources
          : null,
      gitTransports: transports.transports,
      root: typeof root === 'string' && root !== '' ? root : null,
      targetRoots: new Map(
        Object.entries(targets).flatMap(([id, dir]) =>
          typeof dir === 'string' && dir !== '' ? [[id, dir] as const] : [],
        ),
      ),
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
