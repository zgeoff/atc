import { findHostBroker } from '@atc/plugin-api';
import type { ExecutionCapability, HarnessHandle } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionRegistry } from './create-session-registry';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import { waitForKilledExit } from './wait-for-killed-exit';

interface SessionKillerDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'collectChildren' | 'findProvider' | 'remove'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'writeFleet'>;
  readonly callbacks: Pick<
    SessionCallbacks,
    'onEvent' | 'onProcessEnded' | 'log' | 'findAuthBinder'
  >;

  readonly restarts: { readonly stopRestart: (id: SessionID) => Promise<boolean> };

  readonly readExitWaitMs: () => number;
}

export interface SessionKiller {
  readonly kill: (
    id: SessionID,
    stopOnly?: boolean,
  ) => Promise<'stopped' | 'unchanged' | 'removed'>;
  readonly forget: (id: SessionID) => Promise<boolean>;
  readonly pickKillCapability: (session: Session) => ExecutionCapability;

  readonly updateSuspended: (session: Session) => void;

  readonly probeHarnessEnded: (id: SessionID) => Promise<boolean>;
}

export function createSessionKiller(deps: SessionKillerDeps): SessionKiller {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const callbacks = deps.callbacks;
  const restarts = deps.restarts;

  const endingHarnesses = new Map<SessionID, HarnessHandle[]>();

  const removeWithChildren = (session: Session, forgettable: readonly Session[]): void => {
    const kept: Session[] = [];
    const dropped: Session[] = [];

    for (const child of registry.collectChildren(session.id)) {
      const live = child.pty !== null || (child.kind === 'headless' && child.state !== 'exited');

      if (
        live ||
        child.pinned ||
        !forgettable.includes(child) ||
        registry.findProvider(child)?.capabilities.destroy === true
      ) {
        child.parent = null;

        kept.push(child);
      } else {
        dropped.push(child);
      }
    }

    registry.remove(session);

    for (const child of kept) {
      callbacks.onEvent('state', child);
    }

    for (const child of dropped) {
      registry.remove(child);
    }
  };

  const canSuspendHost = (session: Session): boolean =>
    session.hostKey === session.id && registry.findProvider(session)?.capabilities.suspend === true;

  const updateSuspended = (session: Session): void => {
    session.vm = 'asleep';

    if (session.pty === null) {
      callbacks.onEvent('state', session);

      return;
    }

    session.pty.detach();

    session.pty = null;
    session.state = 'exited';
    session.lastMsg = 'asleep';
    session.desired = 'sleep';
    session.attachment = 'detached';
    session.suspended = true;

    callbacks.onEvent('state', session);
  };

  const killTerminal = (session: Session) => {
    if (session.pty !== null) {
      // a provider may report the exit inside the kill call, which clears the session's handle
      const pty = session.pty;

      endingHarnesses.set(session.id, [...(endingHarnesses.get(session.id) ?? []), pty]);
      pty.kill();

      session.pty = null;
    } else if (session.kind !== 'headless' || session.state === 'exited') {
      return;
    }

    session.state = 'exited';
    session.lastMsg = 'killed';
    session.desired = 'stop';

    callbacks.onEvent('state', session);
    callbacks.onProcessEnded(session);
  };

  const stopHarness = async (session: Session): Promise<void> => {
    const provider = registry.findProvider(session);

    if (provider === null || !canSuspendHost(session)) {
      killTerminal(session);

      return;
    }

    await provider.suspendHost(session.hostKey);

    for (const onHost of registry.sessions) {
      if (onHost.hostKey === session.hostKey && onHost.target === session.target) {
        updateSuspended(onHost);
      }
    }
  };

  const tryStopHarness = async (session: Session): Promise<void> => {
    if (session.pty === null) {
      const restartStopped = await restarts.stopRestart(session.id);

      if (!restartStopped) {
        killTerminal(session);
      }

      return;
    }

    try {
      await stopHarness(session);
    } catch (error) {
      callbacks.log(
        `atc could not put the host of session ${session.id} to sleep (${error instanceof Error ? error.message : String(error)}); ending its harness instead`,
      );

      killTerminal(session);
    }
  };

  return {
    kill: async (id, stopOnly = false) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (!session) {
        return 'unchanged';
      }

      const children = registry.collectChildren(id);

      const restartStopped = await restarts.stopRestart(id);

      if (session.pty) {
        await stopHarness(session);

        for (const child of children) {
          if (registry.sessions.includes(child) && child.parent === id) {
            await tryStopHarness(child);
          }
        }
      } else if (restartStopped) {
        for (const child of children) {
          if (registry.sessions.includes(child) && child.parent === id) {
            await tryStopHarness(child);
          }
        }
      } else if (stopOnly) {
        if (session.kind !== 'headless' || session.state === 'exited') {
          return 'unchanged';
        }

        killTerminal(session);

        for (const child of children) {
          if (registry.sessions.includes(child) && child.parent === id) {
            await tryStopHarness(child);
          }
        }
      } else {
        if (registry.findProvider(session)?.capabilities.destroy === true) {
          throw new DaemonError(
            'confirmation_required',
            `forgetting session ${id} destroys its host on target '${session.target}'; confirm it with session.forget`,
            { session: id },
          );
        }

        removeWithChildren(session, children);

        await fleet.writeFleet();

        fleet.emitChange();

        return 'removed';
      }

      await fleet.writeFleet();

      fleet.emitChange();

      return 'stopped';
    },

    forget: async (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return false;
      }

      const children = registry.collectChildren(id);
      const provider = registry.findProvider(session);

      const destroys =
        provider !== null && provider.capabilities.destroy && session.hostKey === session.id;

      if (!destroys && session.pty === null && session.vm === 'asleep') {
        throw new DaemonError(
          'unsupported_operation',
          `session ${id} sleeps inside the host of session ${session.hostKey}; revive it or forget session ${session.hostKey} first`,
          { provider: provider?.kind ?? null, problem: 'host_asleep', host: session.hostKey },
        );
      }

      if (destroys) {
        const binder = callbacks.findAuthBinder();

        const bound =
          binder === null
            ? false
            : await binder.forgetBinding(findHostBroker(provider), session.hostKey);

        if (!bound) {
          await provider.destroyHost(session.hostKey);
        }

        for (const onHost of registry.sessions) {
          if (
            onHost.hostKey === session.hostKey &&
            onHost.target === session.target &&
            onHost.id !== session.id
          ) {
            onHost.pty?.detach();
            onHost.pty = null;

            registry.remove(onHost);
          }
        }

        session.pty?.detach();
        session.pty = null;
      } else {
        killTerminal(session);
      }

      removeWithChildren(session, children);

      await fleet.writeFleet();

      fleet.emitChange();

      return destroys;
    },

    pickKillCapability: (session) => (canSuspendHost(session) ? 'suspend' : 'kill'),

    updateSuspended,

    probeHarnessEnded: async (id) => {
      const ptys = endingHarnesses.get(id) ?? [];
      const waitMs = deps.readExitWaitMs();

      const waits = await Promise.all(
        ptys.map(async (pty) => ({ pty, exited: await waitForKilledExit(pty, waitMs) })),
      );

      const running = collectRunningHarnesses(endingHarnesses.get(id) ?? [], waits);

      if (running.length === 0) {
        endingHarnesses.delete(id);
      } else {
        endingHarnesses.set(id, running);
      }

      return running.length === 0;
    },
  };
}

interface HarnessWait {
  readonly pty: HarnessHandle;
  readonly exited: boolean;
}

function collectRunningHarnesses(
  ending: readonly HarnessHandle[],
  waits: readonly HarnessWait[],
): HarnessHandle[] {
  const exited = new Set(waits.filter((wait) => wait.exited).map((wait) => wait.pty));

  return ending.filter((pty) => !exited.has(pty));
}
