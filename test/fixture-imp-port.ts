import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { posix } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type {
  ColdBoot,
  ColdBootCause,
  ImpCommand,
  ImpCommandResult,
  ImpCreateSpec,
  ImpFeatures,
  ImpIdentity,
  ImpLease,
  ImpPort,
  ImpRelayConnection,
  ImpReverseForward,
  ImpSecret,
  ImpSecretRule,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpState,
  ImpView,
  PreviousGeneration,
  ResumeResult,
} from '../src/daemon/imp-port';
import { ImpPortError } from '../src/daemon/imp-port-error';
import { isImpNameAllowed } from '../src/daemon/is-imp-name-allowed';
import { isBrokerVariable } from '../src/shared/is-broker-variable';

// impd keeps exactly this many bytes of each generation's output.
const RING_BYTES = 262_144;

// The mode bytes a fresh attach sends ahead of a ring that has wrapped.
const PRELUDE = '\u001B[0m';

// The PATH every fixture process runs with: a guest's own, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * An in-process stand-in for impd behind the imp port. Each imp is a set of
 * real `bun-pty` processes on this machine; a sleeping imp stops them with
 * SIGSTOP and a wake continues them, so a memory wake keeps each process
 * and its generation. Every session keeps an exact 262144-byte ring with
 * offsets, a fresh attach skips to the next line and sends a mode prelude,
 * and impd's refusals carry its codes and data: `LEASED`, `LEASE_NOT_HELD`,
 * `NO_SESSION`, `INVALID_STATE`, `INVALID_RESUME`, `NOT_FOUND`, `CONFLICT`,
 * and `FORBIDDEN`. Leases belong to principals; the port acts as
 * `principal`, and a test adds other owners' leases, cold boots, and
 * dropped sockets through the controls. Grants follow impd 0.27: the
 * caller's identity must reach the imp and, under imp patterns, list the
 * secret as grantable; a grant is idempotent, one secret per host, and a
 * destroyed imp or a rebound or removed secret takes its grants with it. A
 * start or an attach that requires the broker is refused with
 * `PRECONDITION_FAILED` and reason `broker_not_ready`, and runs nothing,
 * while the broker fails or the imp holds no grant, when the start sets a
 * broker variable, and when it would join a process that started without
 * the broker required.
 */
// A hold on the commands whose argv holds its text: entered resolves with
// the argv of the first command it holds, and stop lets every command it
// holds run.
interface FixtureCommandHold {
  readonly entered: Promise<string>;
  readonly stop: () => void;
}

export class FixtureImpPort implements ImpPort {
  // Every port call, in order, as `<call> <imp> [<detail>]`.
  readonly calls: string[] = [];

  // Every session request the port received, in order.
  readonly sessionRequests: ImpSessionRequest[] = [];

  features: ImpFeatures = {
    sessionOffsets: true,
    leases: true,
    grantableTokens: true,
    secretRebind: true,
    execRequire: true,
  };

  // Who the port calls impd as.
  private identity: ImpIdentity = {
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  };

  // Grantable secrets rebound or removed since the identity was set, which
  // its list no longer covers, as a secret's new generation leaves a
  // token's list behind.
  private readonly staleGrantable = new Set<string>();

  // The secrets impd holds, by name; which imps hold each is the grants'.
  private readonly secrets = new Map<string, Omit<ImpSecret, 'imps'>>();

  // What a session's agent carries: `none` replays on every connection and
  // ignores resumes.
  continuity: 'offsets' | 'none' = 'offsets';

  // How many bytes before the asked offset an exact resume starts, as
  // impd's at-least-once delivery allows.
  resumeOverlap = 0;

  // Session answers held back while a test lets output pile up, or null
  // when answers go out at once.
  private held: (() => void)[] | null = null;

  // How many of the next session requests impd drops before it answers,
  // and the close code it drops them with.
  private drops = { count: 0, closeCode: 1011 };

  // Lease acquisitions that go through before the next one fails, and
  // impd's code for that failure, or null for none.
  private acquireFailure: { skip: number; readonly code: string } | null = null;

  // A refusal the next session request gets instead of an answer.
  private nextFailure: { readonly code: string; readonly data: unknown } | null = null;

  // Feature reads still to fail as an unreachable impd before they answer.
  private featureFailures = 0;

  // Session connections whose opening still throws before it returns, as
  // an invalid authorization header makes the socket's constructor throw.
  private openFailures = 0;

  // Session connections still to fail their upgrade, ending unreachable
  // before they open and before any gate runs.
  private upgradeFailures = 0;

  // The connections still opening while upgrades are held, each sending
  // its request once it opens; null while connections open at once.
  private upgrades: (() => void)[] | null = null;

  // The lease releases wait for this hold to end, while one is held.
  private releaseHold: PromiseWithResolvers<void> | null = null;

  // The lease acquisitions wait for this hold to end, while one is held.
  private leaseHold: PromiseWithResolvers<void> | null = null;

  // The directory a relative or missing working directory resolves
  // against inside every imp, as a guest's home does; null for the test's
  // own working directory.
  private homeDir: string | null = null;

  // Commands whose argv holds this text wait for the hold to stop, while
  // one is held.
  private commandHold: {
    readonly match: string;
    readonly entered: PromiseWithResolvers<string>;
    readonly done: PromiseWithResolvers<void>;
  } | null = null;

  // Commands whose argv holds this text exit 1 without running, or null.
  private commandFailure: string | null = null;

  // impd's code for every imp destroy while destroys fail, or null.
  private destroyFailure: string | null = null;

  // impd's code for every grant removal while removals fail, or null.
  private grantRemovalFailure: string | null = null;

  // Whether every reverse forward closes each new guest connection at once.
  private refusingRelays = false;

  // Whether the broker fails in every imp, as a CA that did not install
  // leaves it.
  private brokerFailing = false;

  // Whether every relayed connection drops what the guest writes, while
  // what the daemon writes still reaches the guest.
  private droppingGuestBytes = false;

  private readonly principal: string;

  private readonly imps = new Map<string, FixtureImp>();

  private readonly forwards = new Set<{ stop: () => void; stopRelays: () => void }>();

  constructor(principal = 'token:atc') {
    this.principal = principal;
  }

  readFeatures(): Promise<ImpFeatures> {
    this.calls.push('system.info');

    if (this.featureFailures > 0) {
      this.featureFailures -= 1;

      return Promise.reject(new ImpPortError('UNREACHABLE', 'impd did not answer'));
    }

    return Promise.resolve(this.features);
  }

  readIdentity(): Promise<ImpIdentity> {
    this.calls.push('tokens.whoami');

    return Promise.resolve(this.identity);
  }

  readSecrets(): Promise<readonly ImpSecret[]> {
    this.calls.push('secrets.list');

    return Promise.resolve(
      [...this.secrets.values()].map((secret) => ({
        name: secret.name,
        kind: secret.kind,
        rules: secret.rules,
        imps: [...this.imps.values()]
          .filter((imp) => imp.grants.has(secret.name))
          .map((imp) => imp.name),
      })),
    );
  }

  readGrants(name: string): Promise<readonly string[]> {
    this.calls.push(`grants.list ${name}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    return Promise.resolve([...imp.grants]);
  }

  createGrant(name: string, secret: string): Promise<void> {
    this.calls.push(`grants.add ${name} ${secret}`);

    const refusal = this.findGrantRefusal(name, secret);

    if (refusal !== null) {
      return Promise.reject(refusal);
    }

    const imp = this.getImp(name);

    const hosts = new Set(this.secrets.get(secret)?.rules.map((rule) => rule.host));

    const clash = [...imp.grants].find(
      (held) =>
        held !== secret &&
        (this.secrets.get(held)?.rules ?? []).some((rule) => hosts.has(rule.host)),
    );

    if (clash !== undefined) {
      return Promise.reject(
        new ImpPortError('CONFLICT', `grant ${clash} covers a host of ${secret}`, {
          kind: 'grant',
          name: `${name}/${clash}`,
        }),
      );
    }

    imp.grants.add(secret);

    return Promise.resolve();
  }

  removeGrant(name: string, secret: string): Promise<boolean> {
    this.calls.push(`grants.delete ${name} ${secret}`);

    if (this.grantRemovalFailure !== null) {
      return Promise.reject(
        new ImpPortError(this.grantRemovalFailure, 'impd did not remove the grant'),
      );
    }

    const refusal = this.findGrantRefusal(name, secret);

    if (refusal !== null) {
      return Promise.reject(refusal);
    }

    return Promise.resolve(this.getImp(name).grants.delete(secret));
  }

  readImp(name: string): Promise<ImpView | null> {
    this.calls.push(`imps.get ${name}`);

    const imp = this.imps.get(name);
    const view = imp === undefined ? null : this.buildView(imp);

    return Promise.resolve(view);
  }

  createImp(spec: ImpCreateSpec): Promise<ImpView> {
    this.calls.push(`imps.create ${spec.name}`);

    if (this.imps.has(spec.name)) {
      return Promise.reject(
        new ImpPortError('CONFLICT', `imp ${spec.name} exists`, { kind: 'imp', name: spec.name }),
      );
    }

    const imp: FixtureImp = {
      id: randomUUID(),
      name: spec.name,
      state: 'stopped',
      bootId: '',
      coldBoots: [],
      leases: new Map(),
      sessions: new Map(),
      previous: new Map(),
      grants: new Set(),
    };

    this.imps.set(spec.name, imp);
    this.bootCold(imp, 'start');

    return Promise.resolve(this.buildView(imp));
  }

  acquireLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.acquire ${name} ${label}`);

    return this.leaseHold === null
      ? this.applyLease(name, label, ttlSeconds)
      : this.waitForLease(name, label, ttlSeconds);
  }

  private async waitForLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    await this.leaseHold?.promise;

    return this.applyLease(name, label, ttlSeconds);
  }

  private applyLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    const failure = this.acquireFailure;

    if (failure !== null) {
      if (failure.skip === 0) {
        this.acquireFailure = null;

        return Promise.reject(
          new ImpPortError(failure.code, `impd refused the lease (${failure.code})`),
        );
      }

      failure.skip -= 1;
    }

    if (label === 'hold' || ttlSeconds < 10 || ttlSeconds > 3600) {
      return Promise.reject(new ImpPortError('BAD_REQUEST', 'the label or ttl is not allowed'));
    }

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    this.updateAwake(imp);

    const until = Date.now() + ttlSeconds * 1000;

    imp.leases.set(`${this.principal}\u0000${label}`, { principal: this.principal, label, until });

    return Promise.resolve(buildLease(name, this.principal, label, until));
  }

  renewLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.renew ${name} ${label}`);

    const imp = this.imps.get(name);
    const key = `${this.principal}\u0000${label}`;
    const lease = imp?.leases.get(key);

    if (imp === undefined || lease === undefined || lease.until <= Date.now()) {
      return Promise.reject(new ImpPortError('LEASE_NOT_HELD', 'the caller holds no such lease'));
    }

    const until = Date.now() + ttlSeconds * 1000;

    imp.leases.set(key, { ...lease, until });

    return Promise.resolve(buildLease(name, this.principal, label, until));
  }

  releaseLease(name: string, label: string): Promise<boolean> {
    this.calls.push(`leases.release ${name} ${label}`);

    return this.releaseHold === null
      ? this.applyRelease(name, label)
      : this.waitForRelease(name, label);
  }

  private async waitForRelease(name: string, label: string): Promise<boolean> {
    await this.releaseHold?.promise;

    return this.applyRelease(name, label);
  }

  private applyRelease(name: string, label: string): Promise<boolean> {
    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    return Promise.resolve(imp.leases.delete(`${this.principal}\u0000${label}`));
  }

  suspendImp(name: string): Promise<void> {
    this.calls.push(`imps.sleep ${name}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    const live = [...imp.leases.values()].filter((lease) => lease.until > Date.now());

    if (imp.state === 'running' && live.length > 0) {
      const own = live.filter((lease) => lease.principal === this.principal);
      const others = live.filter((lease) => lease.principal !== this.principal);

      const otherPrincipals = new Set(others.map((lease) => lease.principal));

      return Promise.reject(
        new ImpPortError('LEASED', 'the imp is leased', {
          leases: own.map((lease) => buildLease(name, lease.principal, lease.label, lease.until)),
          otherCount: otherPrincipals.size,
        }),
      );
    }

    this.updateAsleep(imp);

    return Promise.resolve();
  }

  destroyImp(name: string): Promise<void> {
    this.calls.push(`imps.destroy ${name}`);

    if (this.destroyFailure !== null) {
      return Promise.reject(
        new ImpPortError(this.destroyFailure, `impd could not destroy ${name}`),
      );
    }

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    for (const proc of imp.sessions.values()) {
      proc.connection?.finish({ kind: 'closed', reason: 'imp destroyed', closeCode: 1000 });
      proc.connection = null;
      proc.exited ??= { code: null };

      tryKill(proc.pty, 'SIGKILL');
    }

    this.imps.delete(name);

    return Promise.resolve();
  }

  openSession(
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ): ImpSessionConnection {
    if (this.openFailures > 0) {
      this.openFailures -= 1;
      throw new TypeError('the authorization header is invalid');
    }

    const outcome = Promise.withResolvers<ImpSessionOutcome>();

    const connection: FixtureConnection = {
      handlers,
      sent: 0,
      finished: false,
      process: null,
      finish: (result) => {
        if (connection.finished) {
          return;
        }

        connection.finished = true;

        if (connection.process?.connection === connection) {
          connection.process.connection = null;
        }

        outcome.resolve(result);
      },
    };

    // The request reaches impd once the connection opens, after the gate
    // lets it go; a closed gate sends nothing.
    const sendToImpd = () => {
      if (gate !== undefined && !tryPassGate(gate)) {
        connection.finish({ kind: 'closed', reason: 'closed before sending', closeCode: 1000 });

        return;
      }

      this.calls.push(`exec.${request.kind} ${request.name} ${request.session}`);
      this.sessionRequests.push(request);

      // impd answers over the network: nothing reaches the caller before
      // openSession returns.
      setTimeout(() => {
        if (this.held === null) {
          this.answerSession(request, connection);
        } else {
          this.held.push(() => {
            this.answerSession(request, connection);
          });
        }
      }, 0);
    };

    if (this.upgradeFailures > 0) {
      this.upgradeFailures -= 1;

      setTimeout(() => {
        connection.finish({ kind: 'unreachable', detail: 'the upgrade failed' });
      }, 0);
    } else if (this.upgrades === null) {
      sendToImpd();
    } else {
      this.upgrades.push(sendToImpd);
    }

    return {
      outcome: outcome.promise,
      write: (data) => {
        if (!connection.finished && connection.process !== null) {
          connection.process.pty.write(new TextDecoder().decode(data));
        }
      },
      resize: (cols, rows) => {
        if (!connection.finished && connection.process !== null) {
          connection.process.pty.resize(cols, rows);
        }
      },
      sendSignal: (signal) => {
        if (!connection.finished && connection.process !== null) {
          tryKill(connection.process.pty, 'SIGCONT');
          tryKill(connection.process.pty, toSignal(signal));
        }
      },
      close: () => {
        connection.finish({ kind: 'closed', reason: 'closed by the client', closeCode: 1000 });
      },
    };
  }

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
  async runCommand(name: string, command: ImpCommand): Promise<ImpCommandResult> {
    this.calls.push(`exec.run ${name} ${command.argv.join(' ')}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      throw buildNotFound(name);
    }

    if (imp.state !== 'running') {
      throw new ImpPortError('INVALID_STATE', `imp ${name} is ${imp.state}`, {
        state: imp.state,
        allowed: ['running'],
      });
    }

    const line = command.argv.join(' ');
    const hold = this.commandHold;

    if (hold !== null && line.includes(hold.match)) {
      hold.entered.resolve(line);

      await hold.done.promise;
    }

    if (this.commandFailure !== null && line.includes(this.commandFailure)) {
      const encoder = new TextEncoder();

      return { code: 1, stdout: new Uint8Array(0), stderr: encoder.encode('the command failed\n') };
    }

    const cwd = this.resolveGuestCwd(command.cwd);

    const proc = Bun.spawn([...command.argv], {
      ...(cwd === undefined ? {} : { cwd }),
      env: { PATH: GUEST_PATH },
      stdin: command.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).bytes(),
      proc.exited,
    ]);

    return { code, stdout, stderr };
  }

  openReverseForward(
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ): ImpReverseForward {
    this.calls.push(`reverse ${name} ${guestPath}`);

    const server = Bun.listen<FixtureRelay>({
      unix: guestPath,
      socket: {
        open: (socket) => {
          const relay: FixtureRelay = {
            dataListeners: [],
            closeListeners: [],
            unsent: new Uint8Array(0),
            roomWaiters: [],
          };

          socket.data = relay;

          if (this.refusingRelays) {
            socket.end();

            return;
          }

          relays.add(socket);

          onConnection({
            onData: (listener) => {
              relay.dataListeners.push(listener);
            },
            onClose: (listener) => {
              relay.closeListeners.push(listener);
            },

            // A socket write takes what fits and drops the rest, so the
            // remainder waits for the next drain.
            write: async (data) => {
              relay.unsent = mergeTail(relay.unsent, data, Number.POSITIVE_INFINITY);
              relay.unsent = relay.unsent.subarray(socket.write(relay.unsent));

              if (relay.unsent.length > 0) {
                const room = Promise.withResolvers<void>();

                relay.roomWaiters.push(room.resolve);

                await room.promise;
              }
            },
            close: () => {
              socket.end();
            },
          });
        },
        data: (socket, buf) => {
          if (this.droppingGuestBytes) {
            return;
          }

          for (const listener of socket.data.dataListeners) {
            listener(new Uint8Array(buf));
          }
        },
        drain(socket) {
          const relay = socket.data;

          relay.unsent = relay.unsent.subarray(socket.write(relay.unsent));

          if (relay.unsent.length === 0) {
            for (const resolve of relay.roomWaiters.splice(0)) {
              resolve();
            }
          }
        },
        close: (socket) => {
          relays.delete(socket);

          for (const resolve of socket.data.roomWaiters.splice(0)) {
            resolve();
          }

          for (const listener of socket.data.closeListeners) {
            listener();
          }
        },
        error() {},
      },
    });

    const relays = new Set<{ readonly end: () => void }>();

    const forward = {
      stop: () => {
        server.stop(true);

        rmSync(guestPath, { force: true });

        this.forwards.delete(forward);
      },
      stopRelays: () => {
        for (const relay of relays) {
          relay.end();
        }
      },
    };

    this.forwards.add(forward);

    return { listening: Promise.resolve(), stop: forward.stop };
  }

  /**
   * Gives impd the features of a daemon from before grantable tokens,
   * secret rebinds and exec requirements, which has none of those flags.
   */
  setOldDaemonFeatures(): void {
    this.features = {
      sessionOffsets: true,
      leases: true,
      grantableTokens: false,
      secretRebind: false,
      execRequire: false,
    };
  }

  /**
   * Sets who the port calls impd as, as a new token in the token file
   * does; its grantable list covers each secret as it is now.
   */
  setIdentity(identity: ImpIdentity): void {
    this.identity = identity;

    this.staleGrantable.clear();
  }

  /**
   * Adds a secret to impd, as `imp secret add` does, with its rules.
   */
  createSecret(name: string, kind: ImpSecret['kind'], rules: readonly ImpSecretRule[]): void {
    this.secrets.set(name, { name, kind, rules });
  }

  /**
   * Changes a secret's rules, as a rebind does: every imp loses its grant
   * of the secret, and no token's grantable list covers it any longer.
   */
  updateSecret(name: string, rules: readonly ImpSecretRule[]): void {
    const secret = this.secrets.get(name);

    if (secret === undefined) {
      throw new Error(`no secret ${name}`);
    }

    this.secrets.set(name, { ...secret, rules });
    this.removeGrants(name);
    this.staleGrantable.add(name);
  }

  /**
   * Deletes a secret, as `imp secret rm` does, with every grant of it; a
   * secret made again under the name is one no token's list covers.
   */
  removeSecret(name: string): void {
    this.secrets.delete(name);
    this.removeGrants(name);
    this.staleGrantable.add(name);
  }

  /**
   * Adds a lease another principal holds on an imp, so it refuses to sleep.
   */
  acquireOtherLease(name: string, principal: string, label: string, ttlSeconds: number): void {
    const imp = this.getImp(name);

    imp.leases.set(`${principal}\u0000${label}`, {
      principal,
      label,
      until: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Puts an imp to sleep with force, as a person's `imp sleep` does: every
   * lease ends and every connection is detached as lost.
   */
  suspendWithForce(name: string): void {
    const imp = this.getImp(name);

    imp.leases.clear();
    this.updateAsleep(imp);
  }

  /**
   * Boots an imp cold for the given cause: every process ends without a
   * delivered exit, and every connection is detached as lost.
   */
  bootImpCold(name: string, cause: ColdBootCause): void {
    this.bootCold(this.getImp(name), cause);
  }

  /**
   * Closes the connection on a session with a WebSocket close code, as impd
   * does when it drops a send under backpressure (1011).
   */
  stopConnection(name: string, session: string, closeCode: number): void {
    const proc = this.getImp(name).sessions.get(session);

    proc?.connection?.finish({ kind: 'closed', reason: `code ${closeCode}`, closeCode });
  }

  /**
   * Closes every guest connection on every reverse forward, as a dropped
   * network does, while each forward keeps listening for the next one.
   */
  stopRelays(): void {
    for (const forward of this.forwards) {
      forward.stopRelays();
    }
  }

  /**
   * Closes each new guest connection on every reverse forward at once, as
   * a network that drops every connection does, until the refusal stops.
   */
  startRelayRefusal(): void {
    this.refusingRelays = true;
  }

  stopRelayRefusal(): void {
    this.refusingRelays = false;
  }

  /**
   * Fails the broker in every imp, as a CA install that failed on boot
   * does, so every start that requires it is refused, until the failure
   * stops.
   */
  startBrokerFailure(): void {
    this.brokerFailing = true;
  }

  stopBrokerFailure(): void {
    this.brokerFailing = false;
  }

  /**
   * Drops every byte a guest writes on a relayed connection, as a network
   * that loses one direction does, until the drop stops; what the daemon
   * writes still reaches the guest.
   */
  startGuestByteDrop(): void {
    this.droppingGuestBytes = true;
  }

  stopGuestByteDrop(): void {
    this.droppingGuestBytes = false;
  }

  /**
   * Holds every session answer back, as a slow network does, until the
   * hold stops.
   */
  startAnswerHold(): void {
    this.held ??= [];
  }

  /**
   * Sends every held answer, in order, and answers at once again.
   */
  stopAnswerHold(): void {
    const held = this.held ?? [];

    this.held = null;

    for (const answer of held) {
      answer();
    }
  }

  /**
   * Fails a lease acquisition with an impd code once `skip` more have gone
   * through.
   */
  setAcquireFailure(skip: number, code: string): void {
    this.acquireFailure = { skip, code };
  }

  /**
   * Drops the next session requests before impd answers them, closing
   * each with the close code.
   */
  setSessionDrops(count: number, closeCode: number): void {
    this.drops = { count, closeCode };
  }

  /**
   * Throws from opening the next session connections, before they return.
   */
  setOpenFailures(count: number): void {
    this.openFailures = count;
  }

  /**
   * Fails the upgrade of the next session connections, so each ends
   * unreachable without opening.
   */
  setUpgradeFailures(count: number): void {
    this.upgradeFailures = count;
  }

  /**
   * Holds every session connection open, as a slow WebSocket upgrade does,
   * so its request reaches impd only once the hold stops.
   */
  startUpgradeHold(): void {
    this.upgrades ??= [];
  }

  // How many connections wait for the upgrade hold to stop.
  countHeldUpgrades(): number {
    return this.upgrades?.length ?? 0;
  }

  /**
   * Opens every held connection, in order, and the next at once.
   */
  stopUpgradeHold(): void {
    const upgrades = this.upgrades ?? [];

    this.upgrades = null;

    for (const send of upgrades) {
      send();
    }
  }

  /**
   * Holds every lease acquisition, as an imp that takes long to wake does,
   * until the hold stops.
   */
  startLeaseHold(): void {
    this.leaseHold ??= Promise.withResolvers<void>();
  }

  /**
   * Lets every held lease acquisition go through, and the next at once.
   */
  stopLeaseHold(): void {
    this.leaseHold?.resolve();
    this.leaseHold = null;
  }

  /**
   * Holds every lease release until the hold stops.
   */
  startReleaseHold(): void {
    this.releaseHold ??= Promise.withResolvers<void>();
  }

  /**
   * Lets every held lease release go through, and the next at once.
   */
  stopReleaseHold(): void {
    this.releaseHold?.resolve();
    this.releaseHold = null;
  }

  /**
   * Resolves every relative working directory inside an imp against dir,
   * as impd resolves one against the guest's home.
   */
  setHomeDir(dir: string): void {
    this.homeDir = dir;
  }

  /**
   * Holds every command whose argv holds match until the returned hold
   * stops. Throws while another hold is active, so no hold replaces one a
   * command still waits on.
   */
  startCommandHold(match: string): FixtureCommandHold {
    if (this.commandHold !== null) {
      throw new Error(`a hold on ${this.commandHold.match} is still active`);
    }

    const hold = {
      match,
      entered: Promise.withResolvers<string>(),
      done: Promise.withResolvers<void>(),
    };

    this.commandHold = hold;

    return {
      entered: hold.entered.promise,
      stop: () => {
        if (this.commandHold === hold) {
          this.commandHold = null;
        }

        hold.done.resolve();
      },
    };
  }

  // Lets every command the active hold holds run, and the next at once.
  stopCommandHold(): void {
    const hold = this.commandHold;

    this.commandHold = null;
    hold?.done.resolve();
  }

  /**
   * Exits 1 from every command whose argv holds match, without running
   * it, until called with null.
   */
  setCommandFailure(match: string | null): void {
    this.commandFailure = match;
  }

  /**
   * Fails every imp destroy with an impd code, leaving the imp, until
   * called with null.
   */
  setDestroyFailure(code: string | null): void {
    this.destroyFailure = code;
  }

  /**
   * Fails every grant removal with an impd code until called with null.
   */
  setGrantRemovalFailure(code: string | null): void {
    this.grantRemovalFailure = code;
  }

  /**
   * Fails the next feature reads as an unreachable impd.
   */
  setFeatureFailures(count: number): void {
    this.featureFailures = count;
  }

  /**
   * Refuses the next session request with an impd code and its data.
   */
  setNextSessionFailure(code: string, data: unknown): void {
    this.nextFailure = { code, data };
  }

  // The state an imp is in, or null when it does not exist.
  findState(name: string): ImpState | null {
    return this.imps.get(name)?.state ?? null;
  }

  // The names of the imps the fixture holds.
  collectImpNames(): string[] {
    return [...this.imps.keys()];
  }

  // The boot an imp runs in.
  getBootID(name: string): string {
    return this.getImp(name).bootId;
  }

  // The generation running under a session name.
  getGeneration(name: string, session: string): string {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.generation;
  }

  // The offset after the last byte a session's running generation wrote.
  getEnd(name: string, session: string): number {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.end;
  }

  [Symbol.dispose](): void {
    this.stopCommandHold();

    for (const imp of this.imps.values()) {
      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
        tryKill(proc.pty, 'SIGKILL');
      }
    }

    for (const forward of this.forwards) {
      forward.stop();
    }

    this.imps.clear();
  }

  // impd's refusal of a grant or revoke: the scope and pattern checks run
  // before anything is looked up, then a missing imp or secret.
  private findGrantRefusal(name: string, secret: string): ImpPortError | null {
    const identity = this.identity;
    const patterns = identity.imps;

    if (identity.scope !== 'manage') {
      return new ImpPortError('FORBIDDEN', 'the caller cannot manage grants', { reason: 'scope' });
    }

    if (patterns !== null && !isImpNameAllowed(patterns, name)) {
      return new ImpPortError('FORBIDDEN', `imp ${name} is outside the caller's patterns`, {
        reason: 'imp_out_of_scope',
      });
    }

    if (
      patterns !== null &&
      (!identity.grantable.includes(secret) || this.staleGrantable.has(secret))
    ) {
      return new ImpPortError('FORBIDDEN', `the caller cannot grant ${secret}`, {
        reason: 'not_grantable',
      });
    }

    if (!this.imps.has(name)) {
      return buildNotFound(name);
    }

    if (!this.secrets.has(secret)) {
      return new ImpPortError('NOT_FOUND', `no secret ${secret}`, { kind: 'secret', name: secret });
    }

    return null;
  }

  private removeGrants(secret: string): void {
    for (const imp of this.imps.values()) {
      imp.grants.delete(secret);
    }
  }

  private getImp(name: string): FixtureImp {
    const imp = this.imps.get(name);

    if (imp === undefined) {
      throw new Error(`no imp ${name}`);
    }

    return imp;
  }

  private buildView(imp: FixtureImp): ImpView {
    const live = [...imp.leases.values()].filter((lease) => lease.until > Date.now());
    const own = live.filter((lease) => lease.principal === this.principal);
    const others = live.filter((lease) => lease.principal !== this.principal);

    return {
      id: imp.id,
      name: imp.name,
      state: imp.state,
      leases: own.map((lease) => buildLease(imp.name, lease.principal, lease.label, lease.until)),
      otherLeaseCount: new Set(others.map((lease) => lease.principal)).size,
    };
  }

  // A sleeping imp wakes from memory with every process as it was; a
  // stopped one boots cold.
  private updateAwake(imp: FixtureImp): void {
    if (imp.state === 'sleeping') {
      imp.state = 'running';

      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
      }
    } else if (imp.state !== 'running') {
      this.bootCold(imp, 'start');
    }
  }

  private updateAsleep(imp: FixtureImp): void {
    if (imp.state !== 'running') {
      return;
    }

    imp.state = 'sleeping';

    for (const proc of imp.sessions.values()) {
      tryKill(proc.pty, 'SIGSTOP');
      proc.connection?.finish({ kind: 'detached', reason: 'lost', offset: proc.end });
    }
  }

  private bootCold(imp: FixtureImp, cause: ColdBootCause): void {
    for (const proc of imp.sessions.values()) {
      proc.connection?.finish({ kind: 'detached', reason: 'lost', offset: proc.end });
      proc.ended = true;

      tryKill(proc.pty, 'SIGCONT');
      tryKill(proc.pty, 'SIGKILL');
    }

    imp.sessions.clear();
    imp.previous.clear();

    imp.state = 'running';
    imp.bootId = randomUUID();

    imp.coldBoots = [
      { bootId: imp.bootId, cause, at: new Date().toISOString() },
      ...imp.coldBoots,
    ].slice(0, 4);
  }

  private answerSession(request: ImpSessionRequest, connection: FixtureConnection): void {
    if (connection.finished) {
      return;
    }

    if (this.drops.count > 0) {
      this.drops.count -= 1;

      connection.finish({
        kind: 'closed',
        reason: `code ${this.drops.closeCode}`,
        closeCode: this.drops.closeCode,
      });

      return;
    }

    const failure = this.nextFailure;

    if (failure !== null) {
      this.nextFailure = null;

      connection.finish({
        kind: 'failed',
        code: failure.code,
        message: `impd refused the session (${failure.code})`,
        data: failure.data,
      });

      return;
    }

    const imp = this.imps.get(request.name);

    if (imp === undefined) {
      connection.finish({
        kind: 'failed',
        code: 'NOT_FOUND',
        message: `no imp ${request.name}`,
        data: { kind: 'imp', name: request.name },
      });

      return;
    }

    if (imp.state !== 'running' && request.kind === 'attach' && !request.wake) {
      connection.finish({
        kind: 'failed',
        code: 'INVALID_STATE',
        message: `imp ${imp.name} is ${imp.state}`,
        data: {
          state: imp.state,
          allowed: ['running'],
          ...(imp.state === 'creating' ? {} : { coldBoots: imp.coldBoots }),
        },
      });

      return;
    }

    this.updateAwake(imp);

    const running = imp.sessions.get(request.session);
    const brokerProblem = this.findBrokerProblem(imp, request, running);

    if (brokerProblem !== null) {
      connection.finish({
        kind: 'failed',
        code: 'PRECONDITION_FAILED',
        message: `the broker is not ready in imp ${imp.name}`,
        data: { reason: 'broker_not_ready', detail: brokerProblem },
      });

      return;
    }

    if (running === undefined && request.kind === 'attach') {
      const previous = imp.previous.get(request.session);

      connection.finish({
        kind: 'failed',
        code: 'NO_SESSION',
        message: `no session ${request.session}`,
        data: {
          bootId: imp.bootId,
          coldBoots: imp.coldBoots,
          ...(previous === undefined ? {} : { previous }),
        },
      });

      return;
    }

    const proc = running ?? this.startProcess(imp, request);

    if (proc === null) {
      return;
    }

    this.attachProcess(imp, proc, request, connection, running === undefined);
  }

  // Why the broker a start or an attach requires is not ready, or null
  // when it is or the request requires nothing. A broker variable the
  // start sets, or a running process that started without the broker
  // required, fails the requirement as impd's would.
  private findBrokerProblem(
    imp: FixtureImp,
    request: ImpSessionRequest,
    running: FixtureProcess | undefined,
  ): string | null {
    if (request.require?.includes('broker') !== true) {
      return null;
    }

    if (this.brokerFailing) {
      return 'the broker CA did not install';
    }

    if (imp.grants.size === 0) {
      return 'the imp holds no grant';
    }

    const overridden =
      request.kind === 'start'
        ? Object.keys(request.env).find((key) => isBrokerVariable(key))
        : undefined;

    if (overridden !== undefined) {
      return overridden;
    }

    return running !== undefined && !running.requireBroker
      ? 'the session did not start with the broker required'
      : null;
  }

  // A working directory as impd resolves it inside an imp: a relative one
  // against the guest's home, when the test gave one.
  private resolveGuestCwd(cwd: string | undefined): string | undefined {
    if (this.homeDir === null || (cwd !== undefined && posix.isAbsolute(cwd))) {
      return cwd;
    }

    return posix.resolve(this.homeDir, cwd ?? '.');
  }

  private startProcess(imp: FixtureImp, request: ImpSessionRequest): FixtureProcess | null {
    if (request.kind !== 'start') {
      return null;
    }

    const pty = spawn(request.argv[0] ?? 'false', request.argv.slice(1), {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: this.resolveGuestCwd(request.cwd) ?? request.cwd,
      env: { ...request.env },
    });

    const proc: FixtureProcess = {
      pty,
      generation: randomBytes(16).toString('hex'),
      ring: new Uint8Array(0),
      end: 0,
      exited: null,
      ended: false,
      connection: null,
      requireBroker: request.require?.includes('broker') === true,
    };

    imp.sessions.set(request.session, proc);

    pty.onData((text) => {
      const data = new TextEncoder().encode(text);

      proc.ring = mergeTail(proc.ring, data, RING_BYTES);
      proc.end += data.length;

      const connection = proc.connection;

      if (connection !== null) {
        connection.sent = proc.end;

        tryEmit(connection, () => {
          connection.handlers.onOutput(data);
        });
      }
    });

    pty.onExit((exit) => {
      if (proc.ended) {
        return;
      }

      const exitCode = exit.exitCode;

      proc.exited = { code: exitCode };

      imp.previous.set(request.session, {
        executionGeneration: proc.generation,
        end: proc.end,
        exitCode,
      });

      const connection = proc.connection;

      // An exit nobody received stays attachable until a connection
      // delivers it.
      if (connection !== null) {
        imp.sessions.delete(request.session);
        connection.finish({ kind: 'exit', code: exitCode, signal: null, offset: proc.end });
      }
    });

    return proc;
  }

  private attachProcess(
    imp: FixtureImp,
    proc: FixtureProcess,
    request: ImpSessionRequest,
    connection: FixtureConnection,
    created: boolean,
  ): void {
    const bufferStart = proc.end - proc.ring.length;
    let from = bufferStart;
    let prelude = '';
    let resume: ResumeResult | undefined;

    if (request.resumeFrom !== undefined && this.continuity === 'offsets') {
      const resumeFrom = request.resumeFrom;

      if (resumeFrom.executionGeneration !== proc.generation) {
        resume = {
          kind: 'generation_changed',
          executionGeneration: proc.generation,
          firstOffset: bufferStart,
        };
      } else if (resumeFrom.offset > proc.end) {
        connection.finish({
          kind: 'failed',
          code: 'INVALID_RESUME',
          message: 'the resume offset is past the end',
          data: { end: proc.end, bufferStart },
        });

        return;
      } else if (resumeFrom.offset < bufferStart) {
        resume = { kind: 'gap', from: resumeFrom.offset, to: bufferStart };
      } else {
        resume = { kind: 'exact' };
        from = Math.max(bufferStart, resumeFrom.offset - this.resumeOverlap);
      }
    } else if (bufferStart > 0) {
      // A ring that has wrapped can start inside an escape sequence, so a
      // fresh attach skips to the next line and resets the modes first.
      const newline = proc.ring.indexOf(0x0a);

      from = bufferStart + (newline === -1 ? 0 : newline + 1);
      prelude = PRELUDE;
    }

    proc.connection?.finish({
      kind: 'detached',
      reason: 'taken_over',
      offset: proc.connection.sent,
    });

    connection.process = proc;
    connection.sent = proc.end;

    const preludeBytes = new TextEncoder().encode(prelude);

    const previous = imp.previous.get(request.session);

    const started = tryEmit(connection, () => {
      connection.handlers.onStarted({
        created,
        output:
          this.continuity === 'none'
            ? { continuity: 'none' }
            : {
                continuity: 'offsets',
                bootId: imp.bootId,
                executionGeneration: proc.generation,
                bufferStart,
                end: proc.end,
                offset: from,
                prelude: preludeBytes.length,
                coldBoots: imp.coldBoots,
                ...(previous === undefined ? {} : { previous }),
                ...(resume === undefined ? {} : { resume }),
              },
      });
    });

    if (!started) {
      return;
    }

    const backlog = proc.ring.subarray(from - bufferStart);

    for (const bytes of [preludeBytes, backlog]) {
      const sent =
        bytes.length === 0 ||
        tryEmit(connection, () => {
          connection.handlers.onOutput(bytes);
        });

      if (!sent) {
        return;
      }
    }

    if (proc.exited !== null) {
      imp.sessions.delete(findSessionName(imp, proc));
      connection.finish({ kind: 'exit', code: proc.exited.code, signal: null, offset: proc.end });

      return;
    }

    proc.connection = connection;
  }
}

interface FixtureLease {
  readonly principal: string;
  readonly label: string;
  readonly until: number;
}

interface FixtureImp {
  readonly id: string;
  readonly name: string;
  state: ImpState;
  bootId: string;
  coldBoots: ColdBoot[];
  readonly leases: Map<string, FixtureLease>;
  readonly sessions: Map<string, FixtureProcess>;
  readonly previous: Map<string, PreviousGeneration>;

  // The secrets granted to the imp.
  readonly grants: Set<string>;
}

interface FixtureProcess {
  readonly pty: IPty;
  readonly generation: string;
  ring: Uint8Array;
  end: number;
  exited: { readonly code: number | null } | null;

  // Ended by a cold boot: its exit is never delivered.
  ended: boolean;
  connection: FixtureConnection | null;

  // Whether its start required the broker, which an attach that requires
  // it needs.
  readonly requireBroker: boolean;
}

interface FixtureConnection {
  readonly handlers: ImpSessionHandlers;
  sent: number;
  finished: boolean;
  process: FixtureProcess | null;
  readonly finish: (outcome: ImpSessionOutcome) => void;
}

interface FixtureRelay {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
  readonly dataListeners: ((data: Uint8Array) => void)[];
  readonly closeListeners: (() => void)[];

  // Bytes a write handed over that the socket has not taken yet, and the
  // writes waiting for them to go.
  unsent: Uint8Array;
  readonly roomWaiters: (() => void)[];
}

function buildNotFound(name: string): ImpPortError {
  return new ImpPortError('NOT_FOUND', `no imp ${name}`, { kind: 'imp', name });
}

function buildLease(name: string, principal: string, label: string, until: number): ImpLease {
  return { name, owner: { principal, display: principal, label }, until };
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- byte arrays have no readonly form
function mergeTail(ring: Uint8Array, data: Uint8Array, limit: number): Uint8Array {
  const joined = new Uint8Array(ring.length + data.length);

  joined.set(ring, 0);
  joined.set(data, ring.length);

  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

// Calls a connection's handler as the imp client does: a handler that
// throws ends the connection with a local error and closes it.
function tryEmit(connection: FixtureConnection, emit: () => void): boolean {
  try {
    emit();

    return true;
  } catch (error) {
    connection.finish({
      kind: 'local_error',
      detail: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}

function findSessionName(imp: FixtureImp, proc: FixtureProcess): string {
  for (const [name, held] of imp.sessions) {
    if (held === proc) {
      return name;
    }
  }

  return '';
}

function toSignal(name: string): NodeJS.Signals {
  return name === 'SIGKILL' || name === 'SIGTERM' || name === 'SIGINT' ? name : 'SIGHUP';
}

function tryKill(pty: IPty, signal: NodeJS.Signals): void {
  try {
    process.kill(pty.pid, signal);
  } catch {}
}

// A gate that throws keeps the request from going out, as a closed one does.
function tryPassGate(gate: () => boolean): boolean {
  try {
    return gate();
  } catch {
    return false;
  }
}
