import { existsSync } from 'node:fs';
import { formatHomePath } from '@atc/core';
import type { SourceInterpretation, SourceProvider } from '@atc/plugin-api';
import { readPathCompletions } from './complete/read-path-completions';
import { resolvePathInput } from './complete/resolve-path-input';
import { readRootDirs } from './read-root-dirs';

// What the source reads besides the spawn history a request brings.
interface DirsSourceServices {
  // The configured roots, each listing its child directories and their
  // worktrees.
  readonly roots: readonly string[];

  // zoxide's frecency list on the daemon's host, most visited first.
  readonly readZoxideDirs: () => Promise<string[]>;

  // The daemon user's home directory, which a leading `~` stands for.
  readonly homeDir: string;
}

export function buildDirsSource(services: DirsSourceServices): SourceProvider {
  return {
    id: 'dirs',
    label: 'directory on the daemon host',
    kind: 'path',
    async list(_query, request) {
      const seen = new Set<string>();

      for (const directory of [
        ...(await request.readSpawnDirs()),
        ...readRootDirs(services.roots),
        ...(await services.readZoxideDirs()),
      ]) {
        if (!seen.has(directory) && existsSync(directory)) {
          seen.add(directory);
        }
      }

      return {
        candidates: [...seen].map((directory) => ({
          label: formatHomePath(directory, services.homeDir),
          pick: { kind: 'path', dir: directory },
        })),
        scope: null,
      };
    },
    interpret(input) {
      // a relative path resolves under the home, as a completion does.
      const directory = resolvePathInput(input.trim(), services.homeDir, services.homeDir);

      const interpretation: SourceInterpretation =
        directory === null ? { kind: 'none' } : { kind: 'path', dir: directory };

      return Promise.resolve(interpretation);
    },
    complete(input, request) {
      // a caller sends its cwd only when the daemon runs on the client's machine,
      // so a relative path resolves under the home otherwise.
      const dirs = readPathCompletions(
        input,
        request.clientCwd ?? services.homeDir,
        services.homeDir,
      );

      return Promise.resolve(
        dirs.map((directory) => ({
          label: formatHomePath(directory, services.homeDir),
          pick: { kind: 'path', dir: directory },
        })),
      );
    },
  };
}
