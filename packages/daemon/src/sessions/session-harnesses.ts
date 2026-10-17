import type { SessionID } from '@atc/core';
import type { ExecutionProvider, HarnessHandle, HarnessStart } from '@atc/plugin-api';
import { formatAuthNotice } from '../auth/format-auth-notice';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import { HARNESS_EXIT_TRANSITIONS } from './harness-exit-transitions';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionKiller } from './session-killer';
import type { SessionRegistry } from './session-registry';

// what a failed start takes back: the auth attempt that provisioned the
// host, and the workspace directory the spawn created, as the host resolves it
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

export class SessionHarnesses {
  // The launches readying each host, by host key. A launch counts from its
  // setup until its harness spawns, which follows the setup with no wait,
  // so a host with a launch in flight is never idle.
  readonly readying = new Map<SessionID, number>();

  // What each listed spawn still waiting on its harness's start readied,
  // by spawn id, so a start that fails takes it back with the session.
  readonly startingSpawns = new Map<SessionID, SpawnReadied>();

  // The runtime auth revision each host's binding held at its latest
  // launch, so a harness that launched under an older one can show it.
  readonly authRevisions = new Map<SessionID, number>();

  // The epoch the next harness start or attach takes, unique across every
  // session this manager holds.
  private nextBridgeEpoch = 1;

  private readonly registry: SessionHarnessesDeps['registry'];

  private readonly fleet: SessionHarnessesDeps['fleet'];

  private readonly killer: SessionHarnessesDeps['killer'];

  private readonly callbacks: SessionHarnessesDeps['callbacks'];

  constructor(deps: SessionHarnessesDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.killer = deps.killer;
    this.callbacks = deps.callbacks;
  }

  attachHarness(s: Session, pty: HarnessHandle, hostLifecycle: boolean): void {
    s.vm = hostLifecycle ? 'awake' : 'none';
    s.attachment = hostLifecycle ? 'attached' : 'local';

    pty.onData((d) => {
      this.callbacks.onOutput(s, d);
    });

    pty.onAttachment?.((attachment) => {
      if (s.pty !== pty || s.attachment === attachment) {
        return;
      }

      s.attachment = attachment;

      if (attachment === 'attached' && this.isAuthOutdated(s)) {
        s.lastMsg = formatAuthNotice(this.authRevisions.get(s.hostKey) ?? 0);
      }

      this.callbacks.onEvent('state', s);
      this.fleet.emitChange();
    });

    pty.onExit((exit) => {
      if (s.pty !== pty) {
        return;
      }

      s.pty = null;

      if (hostLifecycle) {
        s.attachment = 'detached';
      }

      const transition = HARNESS_EXIT_TRANSITIONS[exit.reason ?? 'exited'];

      // a session mid-handoff keeps its headless state, since its terminal
      // dying is expected there
      if (s.kind === 'pty' && s.state !== 'exited') {
        s.state = 'exited';
        s.unread = this.registry.focusedId !== s.id;

        s.lastMsg = transition.takesDetail
          ? (exit.detail ?? transition.message)
          : transition.message;
      }

      if (transition.suspends) {
        s.vm = 'asleep';
        s.suspended = true;
      }

      this.callbacks.onEvent('state', s);
      this.fleet.emitChange();

      if (transition.writesFleet) {
        void this.fleet.tryWriteFleet(s.id);
      }

      if (transition.endsProcess) {
        this.callbacks.onProcessEnded(s);
      }
    });
  }

  // a harness attached to a process the host still ran keeps the revision
  // that process launched under; the fleet write lets a restore after a
  // daemon restart find it
  updateLaunchRevision(
    s: Session,
    revision: number,
    heldRevision: number | null,
    created: boolean,
  ): void {
    const launched = created ? revision : (s.authRevision ?? heldRevision ?? revision);

    if (s.authRevision !== launched) {
      s.authRevision = launched;
      void this.fleet.tryWriteFleet(s.id);
    }

    if (s.pty !== null && this.isAuthOutdated(s)) {
      s.lastMsg = formatAuthNotice(this.authRevisions.get(s.hostKey) ?? revision);

      this.callbacks.onEvent('state', s);
      this.fleet.emitChange();
    }
  }

  async waitForAuthStart(
    s: Session,
    provider: ExecutionProvider,
    pty: HarnessHandle,
  ): Promise<HarnessStart | undefined> {
    try {
      return await pty.waitForStart?.();
    } catch (error) {
      // a spawn with a checkout still to remove leaves the sleep to its
      // rollback, which needs the host awake
      const hasCheckout = (this.startingSpawns.get(s.id)?.root ?? null) !== null;

      if (!hasCheckout && this.isHostIdle(s.hostKey, s.target) && provider.capabilities.suspend) {
        await this.trySuspendIdleHost(provider, s.hostKey, s.target);
      }

      throw error;
    }
  }

  // Whether no harness runs on a host and no launch is readying it.
  isHostIdle(hostKey: SessionID, target: string): boolean {
    return (
      !this.readying.has(hostKey) &&
      !this.registry.sessions.some(
        (other) => other.hostKey === hostKey && other.target === target && other.pty !== null,
      )
    );
  }

  async trySuspendIdleHost(
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<void> {
    try {
      await provider.suspendHost(hostKey, () => this.isHostIdle(hostKey, target));
    } catch (error) {
      this.callbacks.log(
        `atc could not put the host of session ${hostKey} back to sleep after a refused start (${error instanceof Error ? error.message : String(error)})`,
      );

      return;
    }

    for (const onHost of this.registry.sessions) {
      if (onHost.hostKey === hostKey && this.registry.findProvider(onHost) === provider) {
        this.killer.updateSuspended(onHost);
      }
    }

    this.fleet.emitChange();
  }

  // The binding a harness start or attach opens its bridge under, at a
  // fresh epoch.
  mintBridgeBinding(
    sessionID: SessionID,
    target: string,
    targetIdentity: string,
    hostKey: SessionID,
  ): BridgeBinding {
    const epoch = this.nextBridgeEpoch;

    this.nextBridgeEpoch += 1;

    return { sessionID, target, targetIdentity, hostKey, epoch };
  }

  // Readies the host a harness is about to start on and plans the harness.
  // Counts a host as readying while run runs, so it is not idle then.
  async withHostReadying<T>(hostKey: SessionID, run: () => Promise<T>): Promise<T> {
    this.readying.set(hostKey, (this.readying.get(hostKey) ?? 0) + 1);

    try {
      return await run();
    } finally {
      const left = (this.readying.get(hostKey) ?? 1) - 1;

      if (left === 0) {
        this.readying.delete(hostKey);
      } else {
        this.readying.set(hostKey, left);
      }
    }
  }

  // Whether a session's harness launched under an older revision than the
  // one its host's binding held at the latest launch there.
  isAuthOutdated(s: Session): boolean {
    const revision = this.authRevisions.get(s.hostKey);

    return s.authRevision !== undefined && revision !== undefined && s.authRevision < revision;
  }
}
