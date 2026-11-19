import type { HostServices, SourceProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { findGitHubAlternateURL } from './find-github-alternate-url';
import { readGitProtocol } from './read-git-protocol';
import { readGitHubRepos } from './read-github-repos';

interface GitHubSourceOptions {
  readonly id: string;

  readonly run: HostServices['runCommand'];

  readonly bin: string;

  readonly owner: string | null;

  readonly timeoutMs?: number;
}

const GH_TIMEOUT_MS = 20_000;
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;
const OWNER_INPUT_PATTERN = /^(?:github:)?(?<owner>[A-Za-z\d][A-Za-z\d-]{0,38})\/$/u;

const REPO_INPUT_PATTERN =
  /^(?:github:)?(?<owner>[A-Za-z\d][A-Za-z\d-]{0,38})\/(?<repo>[\w-][\w.-]*?)(?:\.git)?$/u;

export function buildGitHubSource(options: GitHubSourceOptions): SourceProvider {
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;

  return {
    id: options.id,
    label: 'GitHub repository',
    kind: 'git',
    async list(query) {
      const owner = query.scope ?? options.owner;

      if (owner !== null && !GITHUB_OWNER_PATTERN.test(owner)) {
        throw new DaemonError('bad_args', 'scope must be a GitHub account or organization');
      }

      const listed = await readGitHubRepos({
        run: options.run,
        bin: options.bin,
        owner,
        timeoutMs,
      });

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

      const protocol = await readGitProtocol(options.run, options.bin, timeoutMs);

      return {
        kind: 'git',
        url: protocol === 'ssh' ? `git@github.com:${name}.git` : `https://github.com/${name}.git`,
      };
    },
    findAlternateURLs(url) {
      const alternate = findGitHubAlternateURL(url);

      return alternate === null ? [] : [alternate];
    },
  };
}

function toCloneURL(url: string): string {
  return url.endsWith('.git') ? url : `${url}.git`;
}
