import type { HostFact } from '@atc/plugin-api';
import type { FleetStore } from '@atc/store';
import type { DaemonID, SessionDescriptor, SessionLifecycle } from '@atcx/contract';
import type { AtcError } from '@atcx/contract/light';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildPlaceKey } from '../fleet/build-place-key';
import { buildSessionLifecycle } from './build-session-lifecycle';
import type { SessionRegistry } from './create-session-registry';
import { pickSessionState } from './pick-session-state';
import type { Session } from './session';

export function collectSessionDescriptors(
  registry: Pick<
    SessionRegistry,
    'sessions' | 'findAdapter' | 'findProvider' | 'findExecutionRefusal' | 'targets'
  >,
  store: Pick<FleetStore, 'daemonID'>,
): SessionDescriptor[] {
  return registry.sessions.map((session) => collectDescriptor(registry, store, session));
}

function collectDescriptor(
  registry: Pick<
    SessionRegistry,
    'findAdapter' | 'findProvider' | 'findExecutionRefusal' | 'targets'
  >,
  store: Pick<FleetStore, 'daemonID'>,
  session: Session,
): SessionDescriptor {
  // session.forget deletes a host only when this check passes, so the descriptor asks the same
  const destroyRefusal = registry.findExecutionRefusal(session, 'destroy');

  return {
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
    place: buildPlace(
      registry.targets.get(session.target),
      session,
      store.daemonID,
      destroyRefusal,
    ),
    canDestroyHost: session.hostKey === session.id && destroyRefusal === null,
  };
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

// A session whose binding its target refuses, because the target changed or never confirmed an
// unversioned binding, must not join the place the target has now. It gets a place of its own,
// keyed by the identity it was saved with.
function buildPlace(
  target: ExecutionTarget | undefined,
  session: Pick<Session, 'target' | 'targetIdentity'>,
  daemonID: DaemonID,
  refusal: AtcError | null,
): SessionDescriptor['place'] {
  const label = target?.label ?? session.target;

  if (target !== undefined && refusal?.code === 'target_changed') {
    return {
      key: buildPlaceKey({
        provider: target.kind,
        placeParts: undefined,
        daemonID,
        targetID: session.target,
        savedIdentity: session.targetIdentity,
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
