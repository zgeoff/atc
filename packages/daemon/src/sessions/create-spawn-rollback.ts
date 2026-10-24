import { EffectRemainsError } from '@atc/plugin-api';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { HostDirClaims } from './create-host-dir-claims';
import type { SessionHarnesses } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import type { SessionCallbacks } from './session-callbacks';

// How long a failed spawn's rollback waits for the killed process to exit
// unless the manager is given another wait.
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
  // How long a failed spawn's rollback waits for the killed process to
  // exit, in milliseconds, once after its kill and once more after a forced
  // kill.
  failedSpawnExitWaitMs: number;

  // Failed spawns whose rollback is running, and those whose killed process
  // it could not confirm gone, each with the harness it ran in, so no revive
  // starts a second harness while the first may still run.
  readonly rollingBack: Set<SessionID>;

  readonly unconfirmedKills: Map<SessionID, HarnessHandle>;

  readonly destroyFailedSpawnHost: (
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    attemptID: string | null,
  ) => Promise<void>;

  // Takes back the trust a failed spawn accepted in the user's own agent
  // config. A take-back that fails is logged and leaves the entry, so the
  // spawn's own failure is the one it reports.
  readonly removeLocalTrust: (remove: (() => Promise<void>) | null, id: SessionID) => Promise<void>;

  readonly shouldTakeHost: (options: ShouldTakeHostOptions) => boolean;

  // Whether a failed spawn's host is destroyed, with the workspace on it: a
  // host of the spawn's own that its provider can destroy, while no other
  // session or launch uses it.
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

    // the directory stays reserved, so no other workspace lands in or
    // around it
    callbacks.log(
      `atc: left ${options.root} on target '${options.target}' after the spawn of session ${options.id} failed to start, since ${reason}; remove it by hand`,
    );

    throw new Error(
      `the workspace ${options.root} on target '${options.target}' could not be removed`,
      errorOptions,
    );
  };

  // Takes back what a spawn attempt bound when the spawn fails before its
  // session lists; a take-back that cannot be confirmed throws.
  const tryRemoveAuthAttempt = async (
    provider: ExecutionProvider,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> => {
    const host = provider.brokerAuth;
    const binder = callbacks.findAuthBinder();

    if (attemptID === null || host === undefined || binder === null) {
      return;
    }

    await binder.removeAttempt(host, hostKey, attemptID);
  };

  // Waits for a killed harness to exit, ending it with a signal it cannot
  // ignore when the first wait runs out and its provider can send one.
  const waitForKilledExit = async (pty: HarnessHandle): Promise<boolean> => {
    const exited = await pty.waitForExit(failedSpawnExitWaitMs);

    if (exited) {
      return true;
    }

    if (pty.killForced === undefined) {
      return false;
    }

    pty.killForced();

    return pty.waitForExit(failedSpawnExitWaitMs);
  };

  const killHarness = async (id: SessionID, pty: HarnessHandle): Promise<boolean> => {
    // stays recorded as possibly running, blocking revives, until a check
    // finds the process gone
    unconfirmedKills.set(id, pty);
    pty.kill();

    const exited = await waitForKilledExit(pty);

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

      // the session counts as rolling back until the spawn's caller ends the
      // rollback
      rollingBack.add(id);

      // an unconfirmed exit keeps the session listed, so the spawn's caller
      // can still find it
      if (pty !== null && !(await killHarness(id, pty))) {
        throw new Error(`session ${id} did not exit after its kill`);
      }

      // A harness other than the killed one would outlive the rollback.
      if (session.pty !== null && session.pty !== pty) {
        throw new Error(`session ${id} started another harness while its spawn rolled back`);
      }

      session.pty = null;

      // the directory stays held once the session leaves the list, so no
      // other workspace lands in or around it before it goes
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
