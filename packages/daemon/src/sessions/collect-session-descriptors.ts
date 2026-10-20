import type { SessionDescriptor, SessionLifecycle } from '@atc/protocol';
import type { FleetStore } from '@atc/store';
import { buildSessionLifecycle } from './build-session-lifecycle';
import { pickSessionState } from './pick-session-state';
import type { Session } from './session';
import type { SessionRegistry } from './session-registry';

export function collectSessionDescriptors(
  registry: Pick<SessionRegistry, 'sessions' | 'findAdapter'>,
  store: Pick<FleetStore, 'daemonID'>,
): SessionDescriptor[] {
  return registry.sessions.map((session) => ({
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    state: pickSessionState(buildLifecycle(session), session.state),
    unread: session.unread,
    lastMsg: session.lastMsg,
    ...(session.lastDetail === undefined ? {} : { lastDetail: session.lastDetail }),
    ...(session.pty === null && session.restoreRefusal?.message === session.lastMsg
      ? { restoreRefusal: session.restoreRefusal.code }
      : {}),
    ...(session.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
    agent: session.agent,
    pinned: session.pinned,
    lastAttachedAt: session.lastAttachedAt,
    repoRoot: session.repoRoot,
    namedBy: session.namedBy,
    createdAt: session.createdAt,
    kind: session.kind,
    alive: session.pty !== null || (session.kind === 'headless' && session.state !== 'exited'),
    canEject: (registry.findAdapter(session.agent)?.headlessRunner ?? null) !== null,
    ...(session.parent === null ? {} : { parent: session.parent }),
    locator: { daemonID: store.daemonID, targetID: session.target },
    ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
    lifecycle: buildLifecycle(session),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
  }));
}

function buildLifecycle(session: Session): SessionLifecycle {
  return buildSessionLifecycle({
    desired: session.desired,
    vm: session.vm,
    attachment: session.attachment,
    suspended: session.suspended,
    hasHarness: session.pty !== null,
    kind: session.kind,
    state: session.state,
  });
}
