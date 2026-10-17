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
  return registry.sessions.map((s) => ({
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    state: pickSessionState(buildLifecycle(s), s.state),
    unread: s.unread,
    lastMsg: s.lastMsg,
    ...(s.lastDetail === undefined ? {} : { lastDetail: s.lastDetail }),
    ...(s.pty === null && s.restoreRefusal?.message === s.lastMsg
      ? { restoreRefusal: s.restoreRefusal.code }
      : {}),
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
    agent: s.agent,
    pinned: s.pinned,
    lastAttachedAt: s.lastAttachedAt,
    repoRoot: s.repoRoot,
    namedBy: s.namedBy,
    createdAt: s.createdAt,
    kind: s.kind,
    alive: s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'),
    canEject: (registry.findAdapter(s.agent)?.headlessRunner ?? null) !== null,
    ...(s.parent === null ? {} : { parent: s.parent }),
    locator: { daemonID: store.daemonID, targetID: s.target },
    ...(s.workspace === undefined ? {} : { workspace: s.workspace }),
    lifecycle: buildLifecycle(s),
    ...(s.model === undefined ? {} : { model: s.model }),
  }));
}

function buildLifecycle(s: Session): SessionLifecycle {
  return buildSessionLifecycle({
    desired: s.desired,
    vm: s.vm,
    attachment: s.attachment,
    suspended: s.suspended,
    hasHarness: s.pty !== null,
    kind: s.kind,
    state: s.state,
  });
}
