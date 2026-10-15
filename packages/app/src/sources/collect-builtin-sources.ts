import type { HostServices, SourceProvider } from '@atc/plugin-api';
import { DIRS_SOURCE_PLUGIN } from '@atc/source-dirs';
import { GIT_SOURCE_PLUGIN } from '@atc/source-git';
import { GITHUB_SOURCE_PLUGIN } from '@atc/source-github';
import { createPluginContract } from '../plugins/create-plugin-contract';

interface BuiltinSourceOptions {
  // The configured directory roots.
  readonly roots: readonly string[];

  // The GitHub owner a listing without a scope lists, or null for the gh
  // account's own repositories.
  readonly githubOwner: string | null;

  // The gh executable: a name looked up on PATH, or a path.
  readonly ghBin: string;

  // The daemon user's home directory.
  readonly homeDir: string;

  // The host's services, whose command runner runs gh and zoxide.
  readonly host: HostServices;
}

/**
 * The built-in sources this host can run, each created by its source
 * plugin from the slice of config it reads: the directories on the daemon's
 * host, GitHub when gh is on this host, and a typed git URL, which needs
 * nothing beyond git.
 */
export function collectBuiltinSources(options: BuiltinSourceOptions): SourceProvider[] {
  const context = { authProfiles: new Map() };

  const dirs = createPluginContract({
    plugin: DIRS_SOURCE_PLUGIN,
    raw: { roots: options.roots, homeDir: options.homeDir },
    entryID: DIRS_SOURCE_PLUGIN.id,
    host: options.host,
    context,
  });

  const git = createPluginContract({
    plugin: GIT_SOURCE_PLUGIN,
    raw: {},
    entryID: GIT_SOURCE_PLUGIN.id,
    host: options.host,
    context,
  });

  if (Bun.which(options.ghBin) === null) {
    return [dirs, git];
  }

  const github = createPluginContract({
    plugin: GITHUB_SOURCE_PLUGIN,
    raw: { owner: options.githubOwner, bin: options.ghBin },
    entryID: GITHUB_SOURCE_PLUGIN.id,
    host: options.host,
    context,
  });

  return [dirs, github, git];
}
