import type { SessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { HostDirClaims } from './host-dir-claims';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionHarnesses } from './session-harnesses';
import type { SessionRegistry } from './session-registry';

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
  readonly callbacks: Pick<SessionCallbacks, 'log' | 'getAuthBinder'>;
}

export class SpawnRollback {
  // How long a failed spawn's rollback waits for the killed process to
  // exit, in milliseconds, once after its kill and once more after a forced
  // kill.
  failedSpawnExitWaitMs = FAILED_SPAWN_EXIT_WAIT_MS;

  // Failed spawns whose rollback is running, and those whose killed process
  // it could not confirm gone, each with the harness it ran in, so no revive
  // starts a second harness while the first may still run.
  readonly rollingBack = new Set<SessionID>();

  readonly unconfirmedKills = new Map<SessionID, HarnessHandle>();

  private readonly registry: SpawnRollbackDeps['registry'];

  private readonly fleet: SpawnRollbackDeps['fleet'];

  private readonly claims: SpawnRollbackDeps['claims'];

  private readonly harnesses: SpawnRollbackDeps['harnesses'];

  private readonly callbacks: SpawnRollbackDeps['callbacks'];

  constructor(deps: SpawnRollbackDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.claims = deps.claims;
    this.harnesses = deps.harnesses;
    this.callbacks = deps.callbacks;
  }

  async destroyFailedSpawnHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> {
    if (attemptID !== null) {
      await this.tryRemoveAuthAttempt(provider, hostKey, attemptID);

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
  }

  // Takes back the trust a failed spawn accepted in the user's own agent
  // config. A take-back that fails is logged and leaves the entry, so the
  // spawn's own failure is the one it reports.
  async removeLocalTrust(remove: (() => Promise<void>) | null, id: SessionID): Promise<void> {
    if (remove === null) {
      return;
    }

    try {
      await remove();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.callbacks.log(
        `atc: the spawn of session ${id} failed to start and taking back its workspace trust failed too: ${reason}`,
      );
    }
  }

  shouldTakeHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    attemptID: string | null,
  ): boolean {
    return attemptID !== null || this.shouldDestroyHost(provider, id, hostKey, target);
  }

  // Whether a failed spawn's host is destroyed, with the workspace on it: a
  // host of the spawn's own that its provider can destroy, while no other
  // session or launch uses it.
  shouldDestroyHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
  ): boolean {
    const isHostInUse =
      this.harnesses.readying.has(hostKey) ||
      this.registry.sessions.some((other) => other.hostKey === hostKey && other.target === target);

    return hostKey === id && provider.capabilities.destroy && !isHostInUse;
  }

  async removeSpawnWorkspace(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    root: string,
  ): Promise<void> {
    try {
      await this.removeWorkspaceDir(provider, id, hostKey, target, root);
    } finally {
      if (
        hostKey !== id &&
        provider.capabilities.suspend &&
        this.harnesses.isHostIdle(hostKey, target)
      ) {
        await this.harnesses.trySuspendIdleHost(provider, hostKey, target);
      }
    }
  }

  private async removeWorkspaceDir(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    root: string,
  ): Promise<void> {
    let removed = false;
    let failure: { readonly cause: unknown; readonly message: string } | null = null;

    try {
      removed = await this.claims.removeClaimedDir(provider, id, hostKey, target, root);
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

    const options = failure === null ? undefined : { cause: failure.cause };

    // the directory stays reserved, so no other workspace lands in or
    // around it
    this.callbacks.log(
      `atc: left ${root} on target '${target}' after the spawn of session ${id} failed to start, since ${reason}; remove it by hand`,
    );

    throw new Error(`the workspace ${root} on target '${target}' could not be removed`, options);
  }

  // Takes back what a spawn attempt bound when the spawn fails before its
  // session lists; a take-back that cannot be confirmed throws.
  private async tryRemoveAuthAttempt(
    provider: ExecutionProvider,
    hostKey: SessionID,
    attemptID: string | null,
  ): Promise<void> {
    const host = provider.brokerAuth;
    const binder = this.callbacks.getAuthBinder();

    if (attemptID === null || host === undefined || binder === null) {
      return;
    }

    await binder.removeAttempt(host, hostKey, attemptID);
  }

  async removeListedSpawn(id: SessionID, root: string | null): Promise<void> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return;
    }

    const pty = s.pty;

    this.harnesses.startingSpawns.delete(id);

    // the session counts as rolling back until the spawn's caller ends the
    // rollback
    this.rollingBack.add(id);

    // an unconfirmed exit keeps the session listed, so the spawn's caller
    // can still find it
    if (pty !== null && !(await this.killHarness(id, pty))) {
      throw new Error(`session ${id} did not exit after its kill`);
    }

    // A harness other than the killed one would outlive the rollback.
    if (s.pty !== null && s.pty !== pty) {
      throw new Error(`session ${id} started another harness while its spawn rolled back`);
    }

    s.pty = null;

    // the directory stays held once the session leaves the list, so no
    // other workspace lands in or around it before it goes
    if (root !== null && s.hostKey !== id) {
      this.claims.reservations.set(id, {
        hostKey: s.hostKey,
        target: s.target,
        dir: s.cwd,
        resolved: root,
        kind: 'workspace',
      });
    }

    this.registry.remove(s);
    this.fleet.emitChange();

    await this.fleet.writeFleet();
  }

  async killHarness(id: SessionID, pty: HarnessHandle): Promise<boolean> {
    // stays recorded as possibly running, blocking revives, until a check
    // finds the process gone
    this.unconfirmedKills.set(id, pty);
    pty.kill();

    const exited = await this.waitForKilledExit(pty);

    if (exited) {
      this.unconfirmedKills.delete(id);
    }

    return exited;
  }

  // Waits for a killed harness to exit, ending it with a signal it cannot
  // ignore when the first wait runs out and its provider can send one.
  private async waitForKilledExit(pty: HarnessHandle): Promise<boolean> {
    const exited = await pty.waitForExit(this.failedSpawnExitWaitMs);

    if (exited) {
      return true;
    }

    if (pty.killForced === undefined) {
      return false;
    }

    pty.killForced();

    return pty.waitForExit(this.failedSpawnExitWaitMs);
  }

  async isRollbackSettled(id: SessionID): Promise<boolean> {
    if (this.rollingBack.has(id)) {
      return false;
    }

    const killed = this.unconfirmedKills.get(id);

    if (killed !== undefined) {
      const gone = await killed.waitForExit(0);

      if (!gone) {
        return false;
      }

      this.unconfirmedKills.delete(id);
    }

    return true;
  }
}
