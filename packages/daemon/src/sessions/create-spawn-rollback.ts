import { EffectRemainsError, findHostBroker } from '@atc/plugin-api';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { HostDirClaims } from './create-host-dir-claims';
import type { SessionHarnesses } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import type { SessionCallbacks } from './session-callbacks';
import { waitForKilledExit } from './wait-for-killed-exit';

const FAILED_SPAWN_EXIT_WAIT_MS = 2000;

interface SpawnRollbackDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'findProvider' | 'remove'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'writeFleet'>;
  readonly claims: Pick<HostDirClaims, 'reservations' | 'removeClaimedDir'>;
  readonly harnesses: Pick<
    SessionHarnesses,
    'readying' | 'startingSpawns' | 'isHostIdle' | 'trySuspendIdleHost'
  >;
  readonly callbacks: Pick<SessionCallbacks, 'log' | 'findAuthBinder'>;
}

interface ShouldTakeHostOptions {
  readonly provider: ExecutionProvider;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly attemptID: string | null;
}

interface RemoveSpawnWorkspaceOptions {
  readonly provider: ExecutionProvider;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly root: string;
}

export interface SpawnRollback {
  failedSpawnExitWaitMs: number;

  readonly rollingBack: Set<SessionID>;

  readonly unconfirmedKills: Map<SessionID, HarnessHandle>;

  readonly destroyFailedSpawnHost: (
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    attemptID: string | null,
  ) => Promise<void>;

  readonly removeLocalTrust: (remove: (() => Promise<void>) | null, id: SessionID) => Promise<void>;

  readonly shouldTakeHost: (options: ShouldTakeHostOptions) => boolean;

  readonly shouldDestroyHost: (
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
  ) => boolean;

  readonly removeSpawnWorkspace: (options: RemoveSpawnWorkspaceOptions) => Promise<void>;

  readonly removeListedSpawn: (id: SessionID, root: string | null) => Promise<void>;
  readonly killHarness: (id: SessionID, pty: HarnessHandle) => Promise<boolean>;
  readonly probeRollbackSettled: (id: SessionID) => Promise<boolean>;
}

export function createSpawnRollback(deps: SpawnRollbackDeps): SpawnRollback {
  let failedSpawnExitWaitMs = FAILED_SPAWN_EXIT_WAIT_MS;

  const rollingBack = new Set<SessionID>();
  const unconfirmedKills = new Map<SessionID, HarnessHandle>();

  const registry = deps.registry;
  const fleet = deps.fleet;
  const claims = deps.claims;
  const harnesses = deps.harnesses;
  const callbacks = deps.callbacks;

  const shouldDestroyHost = (
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
  ): boolean => {
    const isHostInUse =
      harnesses.readying.has(hostKey) ||
      registry.sessions.some((other) => other.hostKey === hostKey && other.target === target);

    return hostKey === id && provider.capabilities.destroy && !isHostInUse;
  };

  const removeWorkspaceDir = async (options: RemoveSpawnWorkspaceOptions): Promise<void> => {
    let removed = false;
    let failure: { readonly cause: unknown; readonly message: string } | null = null;

    try {
      removed = await claims.removeClaimedDir({
        provider: options.provider,
        id: options.id,
        hostKey: options.hostKey,
        target: options.target,
        directory: options.root,
      });
    } catch (error) {
      failure = { cause: error, message: error instanceof Error ? error.message : String(error) };
    }

    if (removed) {
      return;
    }

    const reason =
      failure === null
        ? "another session's directory lies inside it, or it no longer resolves to itself"
        : `removing it failed: ${failure.message}`;

    const errorOptions = failure === null ? undefined : { cause: failure.cause };

    callbacks.log(
      `atc: left ${options.root} on target '${options.target}' after the spawn of session ${options.id} failed to start, since ${reason}; remove it by hand`,
    );

    throw new Error(
      `the workspace ${options.root} on target '${options.target}' could not be removed`,
      errorOptions,
    );
  };

  const tryRemoveAuthAttempt = async (
    provider: ExecutionProvider,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> => {
    const host = findHostBroker(provider);
    const binder = callbacks.findAuthBinder();

    if (attemptID === null || host === null || binder === null) {
      return;
    }

    await binder.removeAttempt(host, hostKey, attemptID);
  };

  const killHarness = async (id: SessionID, pty: HarnessHandle): Promise<boolean> => {
    unconfirmedKills.set(id, pty);
    pty.kill();

    const exited = await waitForKilledExit(pty, failedSpawnExitWaitMs);

    if (exited) {
      unconfirmedKills.delete(id);
    }

    return exited;
  };

  return {
    get failedSpawnExitWaitMs() {
      return failedSpawnExitWaitMs;
    },

    set failedSpawnExitWaitMs(waitMs: number) {
      failedSpawnExitWaitMs = waitMs;
    },

    rollingBack,
    unconfirmedKills,

    destroyFailedSpawnHost: async (provider, id, hostKey, attemptID) => {
      if (attemptID !== null) {
        await tryRemoveAuthAttempt(provider, hostKey, attemptID);

        return;
      }

      if (hostKey === id && provider.capabilities.destroy) {
        try {
          await provider.destroyHost(hostKey);
        } catch (error) {
          throw new EffectRemainsError(
            `spawn of session ${id} failed and destroying its host failed too`,
            { cause: error },
          );
        }
      }
    },

    removeLocalTrust: async (remove, id) => {
      if (remove === null) {
        return;
      }

      try {
        await remove();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        callbacks.log(
          `atc: the spawn of session ${id} failed to start and taking back its workspace trust failed too: ${reason}`,
        );
      }
    },

    shouldTakeHost: (options) =>
      options.attemptID !== null ||
      shouldDestroyHost(options.provider, options.id, options.hostKey, options.target),

    shouldDestroyHost,

    removeSpawnWorkspace: async (options) => {
      try {
        await removeWorkspaceDir(options);
      } finally {
        if (
          options.hostKey !== options.id &&
          options.provider.capabilities.suspend &&
          harnesses.isHostIdle(options.hostKey, options.target)
        ) {
          await harnesses.trySuspendIdleHost(options.provider, options.hostKey, options.target);
        }
      }
    },

    removeListedSpawn: async (id, root) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return;
      }

      const pty = session.pty;

      harnesses.startingSpawns.delete(id);
      rollingBack.add(id);

      if (pty !== null && !(await killHarness(id, pty))) {
        throw new Error(`session ${id} did not exit after its kill`);
      }

      if (session.pty !== null && session.pty !== pty) {
        throw new Error(`session ${id} started another harness while its spawn rolled back`);
      }

      session.pty = null;

      if (root !== null && session.hostKey !== id) {
        claims.reservations.set(id, {
          hostKey: session.hostKey,
          target: session.target,
          directory: session.cwd,
          resolved: root,
          kind: 'workspace',
        });
      }

      registry.remove(session);
      fleet.emitChange();

      await fleet.writeFleet();
    },

    killHarness,

    probeRollbackSettled: async (id) => {
      if (rollingBack.has(id)) {
        return false;
      }

      const killed = unconfirmedKills.get(id);

      if (killed !== undefined) {
        const gone = await killed.waitForExit(0);

        if (!gone) {
          return false;
        }

        unconfirmedKills.delete(id);
      }

      return true;
    },
  };
}
