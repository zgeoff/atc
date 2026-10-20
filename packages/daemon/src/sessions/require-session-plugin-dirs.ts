import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { Session } from './session';
import type { SessionRegistry } from './session-registry';

// Each launch of a session checks the folders its agent's config sets and
// its own as they stand, since the config or the disk may have changed since
// the spawn. A session whose provider is gone counts as remote.
export function requireSessionPluginDirs(
  registry: Pick<SessionRegistry, 'findAdapter' | 'findProvider'>,
  session: Session,
): void {
  requirePluginDirsOnTarget(
    [
      ...(registry.findAdapter(session.agent)?.profile?.pluginDirs ?? []),
      ...(session.pluginDirs ?? []),
    ],
    session.target,
    registry.findProvider(session)?.remote !== false,
  );
}
