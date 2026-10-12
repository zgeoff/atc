import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { expandHome } from '@atc/core/expand-home';
import { formatHomePath } from '@atc/core/format-home-path';
import { collectRootDirs } from '../../shared/collect-root-dirs';
import type { SourceInterpretation, SourceProvider } from '../types';

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

/**
 * The directories on the daemon's host a session can run in: the spawn
 * history the requesting principal may read, most recent first, then the
 * configured roots, then zoxide's list. A directory that no longer exists
 * is left out, and a duplicate keeps its first place. Typed input is a
 * directory when it is absolute or starts with `~`, which stands for the
 * daemon user's home.
 */
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
  };
}
