import type { ExecutionProvider, HarnessHandle, HarnessStart } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import { formatAuthNotice } from '../auth/format-auth-notice';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionKiller } from './create-session-killer';
import type { SessionRegistry } from './create-session-registry';
import { HARNESS_EXIT_TRANSITIONS } from './harness-exit-transitions';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

export interface SpawnReadied {
  readonly attemptID: string | null;
  readonly root: string | null;
}

interface SessionHarnessesDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'focusedId' | 'findProvider'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet'>;
  readonly killer: Pick<SessionKiller, 'updateSuspended'>;
  readonly callbacks: Pick<SessionCallbacks, 'onOutput' | 'onEvent' | 'onProcessEnded' | 'log'>;
}

export interface SessionHarnesses {
  readonly readying: Map<SessionID, number>;

  readonly startingSpawns: Map<SessionID, SpawnReadied>;

  readonly authRevisions: Map<SessionID, number>;

  // A harness that ends without an exit, such as a dropped connection or a host that went to
  // sleep, may leave its process running on the host.
  readonly unconfirmedEnds: ReadonlySet<SessionID>;

  readonly attachHarness: (session: Session, pty: HarnessHandle, hostLifecycle: boolean) => void;

  readonly updateLaunchRevision: (
    session: Session,
    revision: number,
    heldRevision: number | null,
    created: boolean,
  ) => void;

  readonly waitForAuthStart: (
    session: Session,
    provider: ExecutionProvider,
    pty: HarnessHandle,
  ) => Promise<HarnessStart | undefined>;

  readonly isHostIdle: (hostKey: SessionID, target: string) => boolean;

  readonly trySuspendIdleHost: (
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ) => Promise<void>;

  readonly mintBridgeBinding: (
    sessionID: SessionID,
    target: string,
    targetIdentity: string,
    hostKey: SessionID,
  ) => BridgeBinding;

  readonly withHostReadying: <T>(hostKey: SessionID, run: () => Promise<T>) => Promise<T>;

  readonly isAuthOutdated: (session: Session) => boolean;
}

export function createSessionHarnesses(deps: SessionHarnessesDeps): SessionHarnesses {
  const readying = new Map<SessionID, number>();
  const startingSpawns = new Map<SessionID, SpawnReadied>();
  const authRevisions = new Map<SessionID, number>();
  const unconfirmedEnds = new Set<SessionID>();

  let nextBridgeEpoch = 1;
  const registry = deps.registry;
  const fleet = deps.fleet;
  const killer = deps.killer;
  const callbacks = deps.callbacks;

  const isHostIdle = (hostKey: SessionID, target: string): boolean =>
    !readying.has(hostKey) &&
    !registry.sessions.some(
      (other) => other.hostKey === hostKey && other.target === target && other.pty !== null,
    );

  const isAuthOutdated = (session: Session): boolean => {
    const revision = authRevisions.get(session.hostKey);

    return (
      session.authRevision !== undefined &&
      revision !== undefined &&
      session.authRevision < revision
    );
  };

  const trySuspendIdleHost = async (
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<void> => {
    try {
      await provider.suspendHost(hostKey, () => isHostIdle(hostKey, target));
    } catch (error) {
      callbacks.log(
        `atc could not put the host of session ${hostKey} back to sleep after a refused start (${error instanceof Error ? error.message : String(error)})`,
      );

      return;
    }

    for (const onHost of registry.sessions) {
      if (onHost.hostKey === hostKey && registry.findProvider(onHost) === provider) {
        killer.updateSuspended(onHost);
      }
    }

    fleet.emitChange();
  };

  return {
    readying,

    startingSpawns,

    authRevisions,

    unconfirmedEnds,

    attachHarness: (session, pty, hostLifecycle) => {
      unconfirmedEnds.delete(session.id);

      session.vm = hostLifecycle ? 'awake' : 'none';
      session.attachment = hostLifecycle ? 'attached' : 'local';

      pty.onData((data) => {
        callbacks.onOutput(session, data);
      });

      pty.onAttachment?.((attachment) => {
        if (session.pty !== pty || session.attachment === attachment) {
          return;
        }

        session.attachment = attachment;

        if (attachment === 'attached' && isAuthOutdated(session)) {
          session.lastMsg = formatAuthNotice(authRevisions.get(session.hostKey) ?? 0);
        }

        callbacks.onEvent('state', session);
        fleet.emitChange();
      });

      pty.onExit((exit) => {
        if (session.pty !== pty) {
          return;
        }

        session.pty = null;

        if (hostLifecycle) {
          session.attachment = 'detached';
        }

        const reason = exit.reason ?? 'exited';
        const transition = HARNESS_EXIT_TRANSITIONS[reason];

        if (reason !== 'exited') {
          unconfirmedEnds.add(session.id);
        }

        // a session mid-handoff keeps its headless state, since its terminal
        // dying is expected there
        if (session.kind === 'pty' && session.state !== 'exited') {
          session.state = 'exited';
          session.unread = registry.focusedId !== session.id;

          session.lastMsg = transition.takesDetail
            ? (exit.detail ?? transition.message)
            : transition.message;
        }

        if (transition.suspends) {
          session.vm = 'asleep';
          session.suspended = true;
        }

        callbacks.onEvent('state', session);
        fleet.emitChange();

        if (transition.writesFleet) {
          void fleet.tryWriteFleet(session.id);
        }

        if (transition.endsProcess) {
          callbacks.onProcessEnded(session);
        }
      });
    },

    updateLaunchRevision: (session, revision, heldRevision, created) => {
      const launched = created ? revision : (session.authRevision ?? heldRevision ?? revision);

      if (session.authRevision !== launched) {
        session.authRevision = launched;
        void fleet.tryWriteFleet(session.id);
      }

      if (session.pty !== null && isAuthOutdated(session)) {
        session.lastMsg = formatAuthNotice(authRevisions.get(session.hostKey) ?? revision);

        callbacks.onEvent('state', session);
        fleet.emitChange();
      }
    },

    waitForAuthStart: async (session, provider, pty) => {
      try {
        return await pty.waitForStart?.();
      } catch (error) {
        // a spawn with a checkout still to remove leaves the sleep to its
        // rollback, which needs the host awake
        const hasCheckout = (startingSpawns.get(session.id)?.root ?? null) !== null;

        if (
          !hasCheckout &&
          isHostIdle(session.hostKey, session.target) &&
          provider.capabilities.suspend
        ) {
          await trySuspendIdleHost(provider, session.hostKey, session.target);
        }

        throw error;
      }
    },

    isHostIdle,

    trySuspendIdleHost,

    mintBridgeBinding: (sessionID, target, targetIdentity, hostKey) => {
      const epoch = nextBridgeEpoch;

      nextBridgeEpoch += 1;

      return { sessionID, target, targetIdentity, hostKey, epoch };
    },

    withHostReadying: async (hostKey, run) => {
      readying.set(hostKey, (readying.get(hostKey) ?? 0) + 1);

      try {
        return await run();
      } finally {
        const left = (readying.get(hostKey) ?? 1) - 1;

        if (left === 0) {
          readying.delete(hostKey);
        } else {
          readying.set(hostKey, left);
        }
      }
    },

    isAuthOutdated,
  };
}
