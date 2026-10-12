import type { HostServices } from '@atc/plugin-api/host-services';
import type { SourceProvider } from '@atc/plugin-api/types';
import { buildDirsSource } from '@atc/source-dirs/build-dirs-source';
import { buildGitSource } from '@atc/source-git/build-git-source';
import { buildGitHubSource } from '@atc/source-github/build-github-source';

interface BuiltinSourceOptions {
  // The configured directory roots.
  readonly roots: readonly string[];

  // The GitHub owner a listing without a scope lists, or null for the gh
  // account's own repositories.
  readonly githubOwner: string | null;

  // The gh executable: a name looked up on PATH, or a path.
  readonly ghBin: string;

  // The host's command runner, which runs gh.
  readonly runCommand: HostServices['runCommand'];

  // The daemon user's home directory.
  readonly homeDir: string;

  // zoxide's frecency list on the daemon's host.
  readonly collectZoxideDirs: () => Promise<string[]>;
}

/**
 * The built-in sources this host can run, each with its services: the
 * directories on the daemon's host, GitHub when gh is on this host, and
 * a typed git URL, which needs nothing beyond git.
 */
export function collectBuiltinSources(options: BuiltinSourceOptions): SourceProvider[] {
  return [
    buildDirsSource({
      roots: options.roots,
      collectZoxideDirs: options.collectZoxideDirs,
      homeDir: options.homeDir,
    }),
    ...(Bun.which(options.ghBin) === null
      ? []
      : [
          buildGitHubSource({
            run: options.runCommand,
            bin: options.ghBin,
            owner: options.githubOwner,
          }),
        ]),
    buildGitSource(),
  ];
}
