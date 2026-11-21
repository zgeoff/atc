import type { HostFact } from '@atc/plugin-api';
import type { FleetStore } from '@atc/store';
import type { DaemonID, SessionDescriptor, SessionLifecycle } from '@atcx/contract';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildPlaceKey } from '../fleet/build-place-key';
import { isUnconfirmedBinding } from '../fleet/is-unconfirmed-binding';
import { buildSessionLifecycle } from './build-session-lifecycle';
import type { SessionRegistry } from './create-session-registry';
import { pickSessionState } from './pick-session-state';
import type { Session } from './session';

export function collectSessionDescriptors(
  registry: Pick<SessionRegistry, 'sessions' | 'findAdapter' | 'findProvider' | 'targets'>,
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
    ...buildHostField(registry.findProvider(session)?.findHostFact?.(session.hostKey) ?? null),
    place: buildPlace(registry.targets.get(session.target), session, store.daemonID),
    canDestroyHost:
      registry.findProvider(session)?.capabilities.destroy === true &&
      session.hostKey === session.id,
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

function buildHostField(fact: HostFact | null): Pick<SessionDescriptor, 'host'> {
  return fact === null ? {} : { host: fact };
}

// A session kept from an earlier config of its target must not join the place the target has now,
// since restore refuses that binding. It gets a place of its own, keyed by the identity it was
// saved with. A binding that is only unconfirmed counts as the target's own: restore confirms it.
function buildPlace(
  target: ExecutionTarget | undefined,
  session: Pick<Session, 'target' | 'targetIdentity'>,
  daemonID: DaemonID,
): SessionDescriptor['place'] {
  const label = target?.label ?? session.target;

  const isChanged =
    target !== undefined &&
    session.targetIdentity !== target.identity &&
    !isUnconfirmedBinding(target, session.targetIdentity);

  if (isChanged) {
    return {
      key: buildPlaceKey({
        provider: target.kind,
        placeParts: undefined,
        daemonID,
        targetID: `${session.target}:${session.targetIdentity}`,
      }),
      label,
    };
  }

  return {
    key: buildPlaceKey({
      provider: target?.kind ?? '',
      placeParts: target?.placeParts,
      daemonID,
      targetID: session.target,
    }),
    label,
  };
}
