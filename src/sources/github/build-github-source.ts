import { DaemonError } from '../../protocol/daemon-error';
import type { SourceProvider } from '../types';
import { collectGitHubRepos } from './collect-github-repos';
import { readGitProtocol } from './read-git-protocol';

interface GitHubSourceOptions {
  // The gh executable: a name looked up on PATH, or a path.
  readonly bin: string;

  // The owner a listing without a scope lists; null lists the gh account's
  // own repositories.
  readonly owner: string | null;

  // How long each gh command may take; 20 s when unset.
  readonly timeoutMs?: number;
}

// How long a gh command may take before the request is refused.
const GH_TIMEOUT_MS = 20_000;

// A GitHub account or organization login.
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

// Typed `owner/`, which lists that owner.
const OWNER_INPUT_PATTERN = /^(?<owner>[A-Za-z\d][A-Za-z\d-]{0,38})\/$/u;

// Typed `owner/repo`, with or without `.git`.
const REPO_INPUT_PATTERN =
  /^(?<owner>[A-Za-z\d][A-Za-z\d-]{0,38})\/(?<repo>[\w-][\w.-]*?)(?:\.git)?$/u;

/**
 * The GitHub repositories gh on the daemon's host can see. A listing's
 * scope is the owner to list. Typed `owner/` lists that owner, and typed
 * `owner/repo` is that repository at the clone URL the gh config prefers.
 * A listing gh cannot give throws `github_unavailable` with the problem.
 */
export function buildGitHubSource(options: GitHubSourceOptions): SourceProvider {
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;

  return {
    id: 'github',
    label: 'GitHub repository',
    kind: 'git',
    async list(query) {
      const owner = query.scope ?? options.owner;

      if (owner !== null && !GITHUB_OWNER_PATTERN.test(owner)) {
        throw new DaemonError('bad_args', 'scope must be a GitHub account or organization');
      }

      const listed = await collectGitHubRepos({ bin: options.bin, owner, timeoutMs });

      if (!listed.ok) {
        throw new DaemonError(listed.code, listed.message, { problem: listed.problem });
      }

      return {
        candidates: listed.repos.map((repo) => {
          const notes = [
            ...(repo.isPrivate ? ['private'] : []),
            ...(repo.description === '' ? [] : [repo.description]),
          ];

          return {
            label: repo.nameWithOwner,
            ...(notes.length === 0 ? {} : { detail: notes.join(' · ') }),
            pick: {
              kind: 'git',
              url: listed.gitProtocol === 'ssh' ? repo.sshUrl : toCloneURL(repo.url),
            },
          };
        }),
        scope: listed.owner,
      };
    },
    async interpret(input) {
      const text = input.trim();
      const owner = OWNER_INPUT_PATTERN.exec(text)?.groups?.['owner'];

      if (owner !== undefined) {
        return { kind: 'browse', scope: owner };
      }

      const repo = REPO_INPUT_PATTERN.exec(text)?.groups;

      if (repo === undefined) {
        return { kind: 'none' };
      }

      const name = `${repo['owner']}/${repo['repo']}`;

      const protocol = await readGitProtocol(options.bin, timeoutMs);

      return {
        kind: 'git',
        url: protocol === 'ssh' ? `git@github.com:${name}.git` : `https://github.com/${name}.git`,
      };
    },
  };
}

// The https clone URL of a repository's web URL.
function toCloneURL(url: string): string {
  return url.endsWith('.git') ? url : `${url}.git`;
}
