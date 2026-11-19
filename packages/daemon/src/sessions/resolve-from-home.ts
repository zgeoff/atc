import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import { RESOLVE_UNLINKED_DIR_SCRIPT, resolveHostDir } from './resolve-host-dir';
import { resolveHostHome } from './resolve-host-home';

export async function resolveFromHome(
  provider: ExecutionProvider,
  hostKey: SessionID,
  unresolved: readonly (readonly [SessionID, string])[],
): Promise<(readonly [SessionID, string])[] | null> {
  if (unresolved.length === 0) {
    return [];
  }

  // The host follows `..` through symlinks instead of resolving it lexically, so the physical
  // path is unknown here. An absolute directory has already been resolved that way.
  if (unresolved.some(([, cwd]) => posix.isAbsolute(cwd) || cwd.split('/').includes('..'))) {
    return null;
  }

  const home = await resolveHostHome(provider, hostKey).catch(() => null);

  if (home === null) {
    return null;
  }

  const resolved = await Promise.all(
    unresolved.map(async ([id, cwd]) => {
      const absolute = posix.join(home, cwd);

      const physical = await resolveHostDir(
        provider,
        hostKey,
        absolute,
        RESOLVE_UNLINKED_DIR_SCRIPT,
      ).catch(() => null);

      return physical === null
        ? null
        : ([
            [id, absolute],
            [id, physical],
          ] as const);
    }),
  );

  return resolved.some((resolution) => resolution === null)
    ? null
    : resolved.flatMap((resolution) => resolution ?? []);
}
