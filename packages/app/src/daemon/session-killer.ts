import type { SessionID } from '@atc/core';
import type { ExecutionCapability } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionFleetWriter } from './session-fleet-writer';
import type { SessionRegistry } from './session-registry';

interface SessionKillerDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'collectChildren' | 'findProvider' | 'remove'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'writeFleet'>;
  readonly callbacks: Pick<
    SessionCallbacks,
    'onEvent' | 'onProcessEnded' | 'log' | 'getAuthBinder'
  >;
}

/**
 * Ends sessions on purpose: a kill stops a live session and its live
 * sub-sessions, or forgets a dead one, and a forget drops a session for
 * good, destroying its host where its target can.
 */
export class SessionKiller {
  private readonly registry: SessionKillerDeps['registry'];

  private readonly fleet: SessionKillerDeps['fleet'];

  private readonly callbacks: SessionKillerDeps['callbacks'];

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the modules it holds keep mutable session state
  constructor(deps: SessionKillerDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.callbacks = deps.callbacks;
  }

  // A kill's response is the caller's cue that the session is safely
  // archived, so the write it depends on must land before that response
  // goes out. A kill acts on the whole set: killing a session kills its
  // live sub-sessions with it, and forgetting a dead one forgets its dead
  // sub-sessions and promotes any live ones to top level. A live session
  // that owns a host that can sleep puts the host to sleep instead, with
  // every harness on it kept inside, and fails whole when the host stays
  // awake. A dead session on a target that can destroy its host is not
  // forgotten by a kill: forgetting it destroys the host, which takes a
  // confirmed forget. The set is taken before the first await, so a
  // sub-session spawned while the kill waits on a host is not part of it.
  // With stopOnly, a session that is not live is left as it is: nothing
  // changes and nothing is removed. Answers what the kill did.
  async kill(id: SessionID, stopOnly = false): Promise<'stopped' | 'unchanged' | 'removed'> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s) {
      return 'unchanged';
    }

    const children = this.registry.collectChildren(id);

    if (s.pty) {
      await this.stopHarness(s);

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

  /**
   * Forgets a session for good, whether it runs or not, and returns whether
   * its host was destroyed. A session that owns a host its target can
   * destroy destroys the host, and every session on that host goes with it;
   * a session on its parent's host ends its own harness alone, and one
   * kept asleep in that host is refused until the host wakes. Its dead
   * sub-sessions on other hosts go with it, unless their own target can
   * destroy their host or they carry a pin of their own, and its live ones
   * become top-level. A failed destroy
   * throws before anything is forgotten. The sub-sessions it may forget are
   * taken before the first await; one spawned while the forget waits on a
   * host becomes top-level.
   */
  async forget(id: SessionID): Promise<boolean> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    const children = this.registry.collectChildren(id);
    const provider = this.registry.findProvider(s);
    const destroys = provider !== null && provider.capabilities.destroy && s.hostKey === s.id;

    // A harness kept inside a sleeping host it does not own still has a
    // process there, which the daemon can neither reach nor end while the
    // host sleeps. Its record keeps that process owned until the host wakes
    // or its owner's forget destroys the host.
    if (!destroys && s.pty === null && s.vm === 'asleep') {
      throw new DaemonError(
        'unsupported_operation',
        `session ${id} sleeps inside the host of session ${s.hostKey}; revive it or forget session ${s.hostKey} first`,
        { provider: provider?.kind ?? null, problem: 'host_asleep', host: s.hostKey },
      );
    }

    if (destroys) {
      const binder = this.callbacks.getAuthBinder();

      const bound =
        binder === null
          ? false
          : await binder.forgetBinding(provider.brokerAuth ?? null, s.hostKey);

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

  // Removes a forgotten session and its dead sub-sessions, except one whose
  // own target can destroy its host: forgetting that one destroys the host,
  // which takes its own confirmed forget. A sub-session with a pin of its own
  // stays too, since its pin guards it from its parent. Only a sub-session among the given
  // ones may go. Every sub-session that stays becomes top-level before the
  // session's removal is announced, and is announced after it, so no
  // announcement ever finds a sub-session whose parent is gone or a parent
  // standing without the sub-sessions that leave with it.
  private removeWithChildren(s: Session, forgettable: readonly Session[]): void {
    const kept: Session[] = [];
    const dropped: Session[] = [];

    for (const child of this.registry.collectChildren(s.id)) {
      const live = child.pty !== null || (child.kind === 'headless' && child.state !== 'exited');

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

    this.registry.remove(s);

    for (const child of kept) {
      this.callbacks.onEvent('state', child);
    }

    for (const child of dropped) {
      this.registry.remove(child);
    }
  }

  /**
   * The capability a kill of a live session needs on its target: `suspend`
   * for a session that owns a host that can sleep, `kill` for any other.
   */
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

  // A sub-session whose host stays awake is ended instead, so a kill
  // never leaves part of its set running.
  private async tryStopHarness(s: Session): Promise<void> {
    if (s.pty === null) {
      this.killTerminal(s);

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
