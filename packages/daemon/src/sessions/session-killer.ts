import type { SessionID } from '@atc/core';
import type { ExecutionCapability } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionRegistry } from './session-registry';

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

  // Stops a revive's restart that waits on the kill of its outdated
  // harness, and returns whether one was waiting.
  readonly restarts: { readonly stopRestart: (id: SessionID) => Promise<boolean> };
}

export class SessionKiller {
  private readonly registry: SessionKillerDeps['registry'];

  private readonly fleet: SessionKillerDeps['fleet'];

  private readonly callbacks: SessionKillerDeps['callbacks'];

  private readonly restarts: SessionKillerDeps['restarts'];

  constructor(deps: SessionKillerDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.callbacks = deps.callbacks;
    this.restarts = deps.restarts;
  }

  // the response is the caller's cue that the session is safely archived,
  // so the fleet write lands before it
  async kill(id: SessionID, stopOnly = false): Promise<'stopped' | 'unchanged' | 'removed'> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s) {
      return 'unchanged';
    }

    // taken before the first await, so a sub-session spawned while the kill
    // waits on a host is not part of it
    const children = this.registry.collectChildren(id);

    const restartStopped = await this.restarts.stopRestart(id);

    if (s.pty) {
      await this.stopHarness(s);

      for (const child of children) {
        if (this.registry.sessions.includes(child) && child.parent === id) {
          await this.tryStopHarness(child);
        }
      }
    } else if (restartStopped) {
      for (const child of children) {
        if (this.registry.sessions.includes(child) && child.parent === id) {
          await this.tryStopHarness(child);
        }
      }
    } else if (stopOnly) {
      if (s.kind !== 'headless' || s.state === 'exited') {
        return 'unchanged';
      }

      this.killTerminal(s);

      for (const child of children) {
        if (this.registry.sessions.includes(child) && child.parent === id) {
          await this.tryStopHarness(child);
        }
      }
    } else {
      if (this.registry.findProvider(s)?.capabilities.destroy === true) {
        throw new DaemonError(
          'confirmation_required',
          `forgetting session ${id} destroys its host on target '${s.target}'; confirm it with session.forget`,
          { session: id },
        );
      }

      this.removeWithChildren(s, children);

      await this.fleet.writeFleet();

      this.fleet.emitChange();

      return 'removed';
    }

    await this.fleet.writeFleet();

    this.fleet.emitChange();

    return 'stopped';
  }

  async forget(id: SessionID): Promise<boolean> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    // taken before the first await, so a sub-session spawned while the
    // forget waits on a host becomes top-level
    const children = this.registry.collectChildren(id);
    const provider = this.registry.findProvider(s);
    const destroys = provider !== null && provider.capabilities.destroy && s.hostKey === s.id;

    // a harness asleep in a host it does not own has a process the daemon
    // cannot reach or end; its record keeps that process owned until the
    // host wakes or its owner's forget destroys the host
    if (!destroys && s.pty === null && s.vm === 'asleep') {
      throw new DaemonError(
        'unsupported_operation',
        `session ${id} sleeps inside the host of session ${s.hostKey}; revive it or forget session ${s.hostKey} first`,
        { provider: provider?.kind ?? null, problem: 'host_asleep', host: s.hostKey },
      );
    }

    if (destroys) {
      const binder = this.callbacks.findAuthBinder();

      const bound =
        binder === null
          ? false
          : await binder.forgetBinding(provider.brokerAuth ?? null, s.hostKey);

      // a failed destroy throws before anything is forgotten
      if (!bound) {
        await provider.destroyHost(s.hostKey);
      }

      for (const onHost of this.registry.sessions) {
        if (onHost.hostKey === s.hostKey && onHost.target === s.target && onHost.id !== s.id) {
          onHost.pty?.detach();
          onHost.pty = null;

          this.registry.remove(onHost);
        }
      }

      s.pty?.detach();
      s.pty = null;
    } else {
      this.killTerminal(s);
    }

    this.removeWithChildren(s, children);

    await this.fleet.writeFleet();

    this.fleet.emitChange();

    return destroys;
  }

  private removeWithChildren(s: Session, forgettable: readonly Session[]): void {
    const kept: Session[] = [];
    const dropped: Session[] = [];

    for (const child of this.registry.collectChildren(s.id)) {
      const live = child.pty !== null || (child.kind === 'headless' && child.state !== 'exited');

      // a pin of its own guards a sub-session from its parent; one whose
      // target can destroy its host takes its own confirmed forget
      if (
        live ||
        child.pinned ||
        !forgettable.includes(child) ||
        this.registry.findProvider(child)?.capabilities.destroy === true
      ) {
        child.parent = null;

        kept.push(child);
      } else {
        dropped.push(child);
      }
    }

    // kept sub-sessions are top-level before the removal is announced and
    // announced after it, so no announcement finds a parent gone or one
    // standing without the sub-sessions that leave with it
    this.registry.remove(s);

    for (const child of kept) {
      this.callbacks.onEvent('state', child);
    }

    for (const child of dropped) {
      this.registry.remove(child);
    }
  }

  pickKillCapability(s: Session): ExecutionCapability {
    return this.canSuspendHost(s) ? 'suspend' : 'kill';
  }

  private canSuspendHost(s: Session): boolean {
    return s.hostKey === s.id && this.registry.findProvider(s)?.capabilities.suspend === true;
  }

  // Puts the session's host to sleep when it owns one that can sleep, and
  // ends its harness otherwise. A refused sleep throws before anything
  // changes.
  private async stopHarness(s: Session): Promise<void> {
    const provider = this.registry.findProvider(s);

    if (provider === null || !this.canSuspendHost(s)) {
      this.killTerminal(s);

      return;
    }

    await provider.suspendHost(s.hostKey);

    for (const onHost of this.registry.sessions) {
      if (onHost.hostKey === s.hostKey && onHost.target === s.target) {
        this.updateSuspended(onHost);
      }
    }
  }

  // A sub-session whose host stays awake is ended instead, and one whose
  // revive waits on the kill of its outdated harness starts no fresh one,
  // so a kill never leaves part of its set running.
  private async tryStopHarness(s: Session): Promise<void> {
    if (s.pty === null) {
      const restartStopped = await this.restarts.stopRestart(s.id);

      if (!restartStopped) {
        this.killTerminal(s);
      }

      return;
    }

    try {
      await this.stopHarness(s);
    } catch (error) {
      this.callbacks.log(
        `atc could not put the host of session ${s.id} to sleep (${error instanceof Error ? error.message : String(error)}); ending its harness instead`,
      );

      this.killTerminal(s);
    }
  }

  // A harness inside a host that went to sleep: the daemon lets go of it,
  // and the process stays inside the host for a revive to find.
  updateSuspended(s: Session): void {
    s.vm = 'asleep';

    if (s.pty === null) {
      this.callbacks.onEvent('state', s);

      return;
    }

    s.pty.detach();

    s.pty = null;
    s.state = 'exited';
    s.lastMsg = 'asleep';
    s.desired = 'sleep';
    s.attachment = 'detached';
    s.suspended = true;

    this.callbacks.onEvent('state', s);
  }

  // Ends a live session, terminal or headless, leaving a dead entry; a
  // session already dead is left as it is.
  private killTerminal(s: Session) {
    if (s.pty !== null) {
      s.pty.kill();

      s.pty = null;
    } else if (s.kind !== 'headless' || s.state === 'exited') {
      return;
    }

    s.state = 'exited';
    s.lastMsg = 'killed';
    s.desired = 'stop';

    this.callbacks.onEvent('state', s);
    this.callbacks.onProcessEnded(s);
  }
}
