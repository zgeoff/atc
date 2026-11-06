import { isRecord } from '@atc/core';
import { GITHUB_OWNER_PATTERN } from './github-owner-pattern';

interface LegacySources {
  // The old source keys the file sets, in file order.
  readonly keys: readonly string[];

  // The `sources` map the old keys stand for, each entry holding only the
  // fields that differ from a default.
  readonly sources: Record<string, Record<string, unknown>>;

  // One line per old value that the map leaves out.
  readonly problems: readonly string[];
}

// The order the old keys gave when `workspaces.sources` held no list.
const DEFAULT_ORDER = ['dirs', 'github', 'git'];

export function buildLegacySources(file: Readonly<Record<string, unknown>>): LegacySources {
  const workspaces = isRecord(file['workspaces']) ? file['workspaces'] : {};
  const order = workspaces['sources'];
  const owner = workspaces['githubOwner'];
  const problems: string[] = [];
  const sources: Record<string, Record<string, unknown>> = {};

  const ids =
    Array.isArray(order) && order.every((id): id is string => typeof id === 'string' && id !== '')
      ? new Set(order)
      : DEFAULT_ORDER;

  if (owner !== undefined && owner !== null && !isGitHubOwner(owner)) {
    problems.push('workspaces.githubOwner is not a GitHub account or organization; it is left out');
  }

  for (const id of ids) {
    if (id === 'dirs') {
      const roots = collectRoots(file['dirs']);

      sources[id] = roots.length === 0 ? {} : { roots };
    } else if (id === 'github') {
      sources[id] = isGitHubOwner(owner) ? { owner } : {};
    } else if (id === 'git') {
      sources[id] = {};
    } else {
      problems.push(
        `workspaces.sources holds '${id}', which is not a source atc offers; it is left out`,
      );
    }
  }

  return { keys: collectLegacySourceKeys(file, workspaces), sources, problems };
}

function isGitHubOwner(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_OWNER_PATTERN.test(value);
}

// The roots as written, without the items the old parse skipped.
function collectRoots(dirs: unknown): string[] {
  if (!isRecord(dirs) || !Array.isArray(dirs['roots'])) {
    return [];
  }

  return dirs['roots'].filter((root): root is string => typeof root === 'string' && root !== '');
}

function collectLegacySourceKeys(
  file: Readonly<Record<string, unknown>>,
  workspaces: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(file).flatMap((key) => {
    if (key === 'dirs') {
      return ['dirs'];
    }

    if (key === 'workspaces') {
      return Object.keys(workspaces)
        .filter((name) => name === 'githubOwner' || name === 'sources')
        .map((name) => `workspaces.${name}`);
    }

    return [];
  });
}
