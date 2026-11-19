import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import { resolveHostDir } from './resolve-host-dir';

export async function resolveListedDirs(
  provider: ExecutionProvider,
  hostKey: SessionID,
  onHost: readonly { readonly id: SessionID; readonly cwd: string }[],
): Promise<{
  readonly dirs: (readonly [SessionID, string])[];
  readonly unresolved: (readonly [SessionID, string])[];
}> {
  const resolved = await Promise.all(
    onHost.map(async (entry) => {
      const directory = await resolveHostDir(provider, hostKey, entry.cwd).catch(() => null);

      const dirs: (readonly [SessionID, string])[] = [];

      if (posix.isAbsolute(entry.cwd)) {
        dirs.push([entry.id, entry.cwd]);
      }

      if (directory !== null) {
        dirs.push([entry.id, directory]);
      }

      return { dirs, unresolved: directory === null ? [[entry.id, entry.cwd] as const] : [] };
    }),
  );

  return {
    dirs: resolved.flatMap((resolution) => resolution.dirs),
    unresolved: resolved.flatMap((resolution) => resolution.unresolved),
  };
}
