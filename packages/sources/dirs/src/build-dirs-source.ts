import { existsSync } from 'node:fs';
import { formatHomePath } from '@atc/core';
import type { SourceInterpretation, SourceProvider } from '@atc/plugin-api';
import { readPathCompletions } from './complete/read-path-completions';
import { resolvePathInput } from './complete/resolve-path-input';
import { readRootDirs } from './read-root-dirs';

interface DirsSourceServices {
  readonly id: string;

  readonly roots: readonly string[];

  readonly readZoxideDirs: () => Promise<string[]>;

  readonly homeDir: string;
}

export function buildDirsSource(services: DirsSourceServices): SourceProvider {
  return {
    id: services.id,
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
          pick: { kind: 'path', directory },
        })),
        scope: null,
      };
    },
    interpret(input, request) {
      const directory = resolvePathInput(
        input.trim(),
        request.clientCwd ?? services.homeDir,
        services.homeDir,
      );

      const interpretation: SourceInterpretation =
        directory === null ? { kind: 'none' } : { kind: 'path', directory };

      return Promise.resolve(interpretation);
    },
    complete(input, request) {
      const dirs = readPathCompletions(
        input,
        request.clientCwd ?? services.homeDir,
        services.homeDir,
      );

      return Promise.resolve(
        dirs.map((directory) => ({
          label: formatHomePath(directory, services.homeDir),
          pick: { kind: 'path', directory },
        })),
      );
    },
  };
}
