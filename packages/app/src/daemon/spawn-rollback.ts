import type { SessionID } from '@atc/core/session-id';
import { EffectRemainsError } from '@atc/plugin-api/effect-remains-error';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api/execution-provider';
import type { HostDirClaims } from './host-dir-claims';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionFleetWriter } from './session-fleet-writer';
import type { SessionHarnesses, SpawnReadied } from './session-harnesses';
import type { SessionRegistry } from './session-registry';

// How long a failed spawn's rollback waits for the killed process to exit
// unless the manager is given another wait.
const FAILED_SPAWN_EXIT_WAIT_MS = 2000;

interface SpawnRollbackDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'findProvider' | 'remove'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'writeFleet'>;
  readonly claims: Pick<HostDirClaims, 'reservations' | 'releaseWorkspace' | 'removeClaimedDir'>;
  readonly harnesses: Pick<
    SessionHarnesses,
    'readying' | 'startingSpawns' | 'isHostIdle' | 'trySuspendIdleHost'
  >;
  readonly callbacks: Pick<SessionCallbacks, 'log' | 'getAuthBinder'>;
}

/**
 * Takes back a spawn that failed: what it readied on its host before or
 * after its session listed, and the harness it started, which no revive
 * runs again until its exit is confirmed.
 */
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

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the modules it holds keep mutable session state
  constructor(deps: SpawnRollbackDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.claims = deps.claims;
    this.harnesses = deps.harnesses;
    this.callbacks = deps.callbacks;
  }

  // Takes back the host a spawn readied when the spawn fails before its
  // session lists: an attempt that provisioned the host takes back its imp
  // and binding, and a host of the spawn's own without one is destroyed. A
  // parent's host stays as it is. A take-back that fails throws, and a
  // destroy that fails throws that the host may still stand.
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

  // Takes back what a spawn readied when it fails once its host is ready,
  // before or after its session lists. An attempt that provisioned the
  // host takes back its imp and binding; a host of the spawn's own without
  // one is destroyed while no other session or launch uses it. On a host
  // that stays, such as a parent's, only the workspace directory the spawn
  // created goes. A directory it cannot confirm gone stays reserved, is
  // logged for an operator to remove, and throws that it may still stand.
  async removeFailedSpawnEffects(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    readied: SpawnReadied,
  ): Promise<void> {
    const isHostInUse =
      this.harnesses.readying.has(hostKey) ||
      this.registry.sessions.some((other) => other.hostKey === hostKey && other.target === target);

    if (
      readied.attemptID !== null ||
      (hostKey === id && provider.capabilities.destroy && !isHostInUse)
    ) {
      await this.destroyFailedSpawnHost(provider, id, hostKey, readied.attemptID);

      return;
    }

    const root = readied.root;

    if (root === null) {
      return;
    }

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

    this.callbacks.log(
      `atc: left ${root} on target '${target}' after the spawn of session ${id} failed to start, since ${reason}; remove it by hand`,
    );

    throw new EffectRemainsError(
      `spawn of session ${id} failed and its workspace ${root} on target '${target}' could not be removed`,
      options,
    );
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

  // Takes back a spawn that failed after its process started: the process
  // dies, the session leaves the list and the fleet, and what the spawn
  // readied on its host goes, so the spawn leaves nothing behind. It
  // resolves only once the process has exited, the fleet without the
  // session is durable, and that take-back is confirmed, and throws when
  // any of them cannot be confirmed. A session whose exit is not
  // confirmed stays listed, so the spawn's caller can still find it, and
  // no revive starts it until its process is found gone. A session that
  // never registered is left alone.
  async removeFailedSpawn(id: SessionID): Promise<void> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return;
    }

    const pty = s.pty;
    const readied = this.harnesses.startingSpawns.get(id) ?? null;

    this.harnesses.startingSpawns.delete(id);
    this.rollingBack.add(id);

    try {
      if (pty !== null) {
        await this.killFailedSpawn(id, pty);
      }

      // A harness other than the killed one would outlive the rollback.
      if (s.pty !== null && s.pty !== pty) {
        throw new Error(`session ${id} started another harness while its spawn rolled back`);
      }

      s.pty = null;

      // The directory stays held on a shared host once the session leaves
      // the list, so no other workspace lands in or around it before it goes.
      if (readied !== null && readied.root !== null && s.hostKey !== id) {
        this.claims.reservations.set(id, {
          hostKey: s.hostKey,
          target: s.target,
          dir: s.cwd,
          resolved: readied.root,
          kind: 'workspace',
        });
      }

      this.registry.remove(s);
      this.fleet.emitChange();

      await this.fleet.writeFleet();

      if (readied !== null) {
        const provider = this.registry.findProvider(s);

        if (provider === null) {
          throw new Error(`the target of session ${id} is gone, so its failed spawn stays`);
        }

        try {
          await this.removeFailedSpawnEffects(provider, id, s.hostKey, s.target, readied);
        } finally {
          // A shared host stays awake for the checkout's removal, then goes
          // back to sleep when nothing else runs there.
          if (
            readied.root !== null &&
            s.hostKey !== id &&
            provider.capabilities.suspend &&
            this.harnesses.isHostIdle(s.hostKey, s.target)
          ) {
            await this.harnesses.trySuspendIdleHost(provider, s.hostKey, s.target);
          }
        }
      }

      this.claims.releaseWorkspace(id);
    } finally {
      this.rollingBack.delete(id);
    }
  }

  // Kills a failed spawn's harness and waits for its exit. A kill that
  // throws or an exit it cannot confirm leaves the harness recorded as
  // possibly running, which blocks revives of the session.
  private async killFailedSpawn(id: SessionID, pty: HarnessHandle): Promise<void> {
    this.unconfirmedKills.set(id, pty);
    pty.kill();

    const exited = await this.waitForKilledExit(pty);

    if (!exited) {
      throw new Error(`session ${id} did not exit after its kill`);
    }

    this.unconfirmedKills.delete(id);
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

  // Whether a failed spawn's rollback leaves the session free to revive:
  // none is running, and any process it killed is gone now. A session whose
  // killed process may still run stays blocked until a later check finds it
  // gone.
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
