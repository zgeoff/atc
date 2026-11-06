import type { SourceEntry } from '@atc/config';
import type { HostServices, SourceProvider } from '@atc/plugin-api';
import { DIRS_SOURCE_PLUGIN } from '@atc/source-dirs';
import { GIT_SOURCE_PLUGIN } from '@atc/source-git';
import { GITHUB_SOURCE_PLUGIN } from '@atc/source-github';
import { match } from 'ts-pattern';
import { createPluginContract } from '../plugins/create-plugin-contract';

interface BuiltinSourceOptions {
  // The config's sources, in picker order.
  readonly entries: readonly SourceEntry[];

  // The daemon user's home directory.
  readonly homeDir: string;

  // The host's services, whose command runner runs gh and zoxide.
  readonly host: HostServices;
}

interface BuiltinSources {
  readonly sources: SourceProvider[];

  // One line per entry this host cannot run, which the daemon leaves out.
  readonly problems: string[];
}

export function createBuiltinSources(options: BuiltinSourceOptions): BuiltinSources {
  const context = { authProfiles: new Map() };
  const sources: SourceProvider[] = [];
  const problems: string[] = [];

  for (const entry of options.entries) {
    const base = { entryID: entry.id, host: options.host, context };

    const source = match(entry)
      .with({ kind: 'dirs' }, (dirs) =>
        createPluginContract({
          ...base,
          plugin: DIRS_SOURCE_PLUGIN,
          raw: { roots: dirs.roots, homeDir: options.homeDir },
        }),
      )
      .with({ kind: 'github' }, (github) =>
        Bun.which(github.bin) === null
          ? null
          : createPluginContract({
              ...base,
              plugin: GITHUB_SOURCE_PLUGIN,
              raw: { owner: github.owner, bin: github.bin },
            }),
      )
      .with({ kind: 'git' }, () =>
        createPluginContract({ ...base, plugin: GIT_SOURCE_PLUGIN, raw: {} }),
      )
      .exhaustive();

    if (source === null) {
      problems.push(`sources.${entry.id}: gh is not on the daemon's PATH; left out`);
    } else {
      sources.push(source);
    }
  }

  return { sources, problems };
}
