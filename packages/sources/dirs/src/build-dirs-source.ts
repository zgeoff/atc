import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { expandHome, formatHomePath } from '@atc/core';
import type { SourceInterpretation, SourceProvider } from '@atc/plugin-api';
import { collectRootDirs } from './collect-root-dirs';
import { collectPathCompletions } from './complete/collect-path-completions';

// What the source reads besides the spawn history a request brings.
interface DirsSourceServices {
  // The configured roots, each listing its child directories and their
  // worktrees.
  readonly roots: readonly string[];

  // zoxide's frecency list on the daemon's host, most visited first.
  readonly collectZoxideDirs: () => Promise<string[]>;

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

      for (const dir of [
        ...(await request.collectSpawnDirs()),
        ...collectRootDirs(services.roots),
        ...(await services.collectZoxideDirs()),
      ]) {
        if (!seen.has(dir) && existsSync(dir)) {
          seen.add(dir);
        }
      }

      return {
        candidates: [...seen].map((dir) => ({
          label: formatHomePath(dir, services.homeDir),
          pick: { kind: 'path', dir },
        })),
        scope: null,
      };
    },
    interpret(input) {
      const text = input.trim();
      const dir = expandHome(text, services.homeDir);

      const interpretation: SourceInterpretation = isAbsolute(dir)
        ? { kind: 'path', dir }
        : { kind: 'none' };

      return Promise.resolve(interpretation);
    },
    complete(input, request) {
      // a caller sends its cwd only when the daemon runs on the client's machine,
      // so a relative path resolves under the home otherwise.
      const dirs = collectPathCompletions(
        input,
        request.clientCwd ?? services.homeDir,
        services.homeDir,
      );

      return Promise.resolve(
        dirs.map((dir) => ({
          label: formatHomePath(dir, services.homeDir),
          pick: { kind: 'path', dir },
        })),
      );
    },
  };
}
