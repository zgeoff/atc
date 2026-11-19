import type { SessionRegistry } from './create-session-registry';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { Session } from './session';

// The agent config and the disk can change after the spawn, so every launch rechecks the plugin
// folders instead of trusting the spawn-time check.
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
