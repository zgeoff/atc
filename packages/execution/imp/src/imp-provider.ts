import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { isCompiledBinary } from '@atc/config/is-compiled-binary';
import { buildTarArchive } from '@atc/core/build-tar-archive';
import { createStepTimer } from '@atc/core/create-step-timer';
import { makeKeyedLock } from '@atc/core/make-keyed-lock';
import type { CredentialBroker } from '@atc/plugin-api/credential-broker';
import { EffectRemainsError } from '@atc/plugin-api/effect-remains-error';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessHandle,
  HarnessRelay,
  HarnessSpec,
  HostRequest,
} from '@atc/plugin-api/execution-provider';
import { isHostNameAllowed } from '@atc/plugin-api/is-host-name-allowed';
import { buildSessionEnv } from '@atc/protocol/build-session-env';
import { DaemonError } from '@atc/protocol/daemon-error';
import { LineDecoder } from '@atc/protocol/line-decoder';
import { SESSION_ENV_NAMES } from '@atc/protocol/session-env-names';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { buildImpCredentialBroker } from './build-imp-credential-broker';
import { buildImpName } from './build-imp-name';
import { buildShortName } from './build-short-name';
import CHECK_GUEST_ATC_SCRIPT from './check-guest-atc.sh' with { type: 'text' };
import { ImpHarness } from './imp-harness';
import type { ImpCreateSpec, ImpForwardEnd, ImpPort, ImpRelayConnection } from './imp-port';
import { ImpPortError } from './imp-port-error';
import INSTALL_GUEST_ATC_SCRIPT from './install-guest-atc.sh' with { type: 'text' };
import LINK_GUEST_ATC_SCRIPT from './link-guest-atc.sh' with { type: 'text' };
import READ_GUEST_ATC_SCRIPT from './read-guest-atc.sh' with { type: 'text' };
import READY_GUEST_DIR_SCRIPT from './ready-guest-dir.sh' with { type: 'text' };
import UNPACK_SCRIPT from './unpack-archive.sh' with { type: 'text' };

/**
 * The options an `imp` target takes beside its provider: the image a new
 * imp boots, the memory it gets, the folder inside each imp that atc's
 * files go under, the path of an atc binary already installed in the
 * image, the prefix every imp name the target builds starts with, and
 * whether a launch rebinds a host whose auth selection changed. None holds
 * a credential.
 */
interface ImpTargetOptions {
  readonly impPrefix?: string;
  readonly rebindChangedAuth?: boolean;
  readonly image?: string;
  readonly memoryMib?: number;
  readonly guestDir?: string;
  readonly guestATC?: string;
}

interface ImpProviderOptions {
  // How long each lease the daemon takes lasts before a renewal, in seconds.
  readonly leaseSeconds?: number;

  // The wait before each reconnect to a harness whose connection ended
  // without an exit, in milliseconds.
  readonly reconnectDelaysMs?: readonly number[];

  // The Linux atc binary on the daemon's machine that the provider copies
  // into an imp without one, or null for none. A compiled daemon on Linux
  // copies itself; one run from source has no binary to copy.
  readonly atcBinary?: string | null;

  // The atc version the daemon runs, which the image's atc must print for
  // hooks to run it.
  readonly version: string;
}

// The folder inside an imp that atc's files go under when the target sets
// none.
const GUEST_DIR = '/tmp/atc';

// The start of every imp name when the target sets no prefix.
const IMP_PREFIX = 'atc-';

// impd takes a lease of 10 to 3600 seconds; the daemon renews at a third of it.
const LEASE_SECONDS = 600;

// About 15 seconds of reconnects before a harness counts as ended.
const RECONNECT_DELAYS_MS: readonly number[] = [250, 1000, 2000, 4000, 8000];

// The PATH a guest harness runs with: the guest's standard one, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const gzipAsync = promisify(gzip);

// Level 2 keeps nearly all of level 6's ratio on a workspace tar at about
// two thirds of its CPU time.
const GZIP_LEVEL = 2;

// The exit an imp without gzip answers a transfer with: EX_UNAVAILABLE,
// which neither mkdir nor tar uses.
const NO_GZIP_CODE = 69;

/**
 * The `imp` provider: one imp, a VM that impd hosts, per top-level session,
 * and every sub-session on the same target in its parent's imp. The daemon
 * holds each imp it uses with a lease labelled `atc-<daemonID>`, renews it
 * while a harness runs there, and gives it back when the last harness ends
 * or before it puts the imp to sleep; it never forces a sleep. Each harness
 * is an imp session, and the daemon is its one attacher.
 */
export class ImpProvider implements ExecutionProvider {
  readonly kind = 'imp';

  readonly remote = true;

  readonly capabilities: ExecutionCapabilities = {
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    headless: false,
    suspend: true,
    destroy: true,
  };

  readonly guest: GuestLayout;

  // The literal start of every imp name this provider builds: the runtime
  // namespace an impd token's imp patterns are checked against.
  readonly impPrefix: string;

  readonly brokerAuth: CredentialBroker;

  readonly rebindChangedAuth: boolean;

  private readonly port: ImpPort;

  private readonly target: ImpTargetOptions;

  private readonly leaseSeconds: number;

  private readonly reconnectDelaysMs: readonly number[];

  private readonly hosts = new Map<string, ImpHost>();

  // Each imp's readyings, sleeps, and lease returns run one after another,
  // in the order they were asked for, so none of them gives back the lease
  // a readying just took.
  private readonly withHostTurn = makeKeyedLock();

  // The readyings of each imp still waiting for their turn.
  private readonly waitingPrepares = new Map<string, number>();

  private readonly atcBinary: string | null;

  private readonly version: string;

  // The version the image's atc printed on each imp, or null for an imp
  // without one, kept once a readying of the imp succeeds: an imp's image
  // never changes, and `bin/atc` there then runs the daemon's version.
  private readonly imageATCVersions = new Map<string, string | null>();

  // Whether impd carries output offsets, once a prepare has read its
  // features; an impd without the flag carries none.
  private offsets = false;

  // The lease label of the daemon this provider serves, once a prepare
  // names it.
  private label: string | null = null;

  constructor(port: ImpPort, target: ImpTargetOptions, options: ImpProviderOptions) {
    this.port = port;
    this.target = target;
    this.impPrefix = target.impPrefix ?? IMP_PREFIX;
    this.rebindChangedAuth = target.rebindChangedAuth ?? false;
    this.leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.atcBinary = options.atcBinary === undefined ? findOwnLinuxBinary() : options.atcBinary;
    this.version = options.version;

    const dir = target.guestDir ?? GUEST_DIR;

    // Hooks always run `bin/atc`, since a session's hooks are planned before
    // its imp is readied and the readying decides what that path holds.
    this.guest = {
      dir,
      atc: target.guestATC === undefined && this.atcBinary === null ? null : `${dir}/bin/atc`,
    };

    this.brokerAuth = buildImpCredentialBroker(port, {
      impPrefix: this.impPrefix,
      getImpName: (hostKey) => this.getImpName(hostKey),
      createImp: (hostKey) => port.createImp(buildCreateImpSpec(this.getImpName(hostKey), target)),
      destroyImp: (hostKey) => this.destroyHost(hostKey),
    });
  }

  // The imp a host key runs on, under this provider's prefix.
  getImpName(hostKey: string): string {
    return buildImpName(this.impPrefix, hostKey);
  }

  // The provider's record of a host, made and kept on the first ask.
  private getHost(hostKey: string): ImpHost {
    const host = this.hosts.get(hostKey) ?? {
      name: this.getImpName(hostKey),
      harnesses: 0,
      renewTimer: null,
      suspending: false,
      isIdle: null,
      log: null,
    };

    this.hosts.set(hostKey, host);

    return host;
  }

  readonly checkExistingHost = async (host: string): Promise<boolean> => {
    try {
      const name = this.getImpName(host);

      const identity = await this.port.readIdentity();

      if (
        identity.scope === 'read' ||
        (identity.imps !== null && !isHostNameAllowed(identity.imps, name))
      ) {
        return false;
      }

      return (await this.port.readImp(name)) !== null;
    } catch {
      return false;
    }
  };

  // Creates the host's imp when impd holds none, then takes the daemon's
  // lease, which boots or wakes the imp.
  readonly prepareHost = (request: HostRequest): Promise<void> => {
    const name = this.getImpName(request.host);

    this.waitingPrepares.set(name, (this.waitingPrepares.get(name) ?? 0) + 1);

    return this.withHostTurn(name, () => {
      const left = (this.waitingPrepares.get(name) ?? 1) - 1;

      if (left === 0) {
        this.waitingPrepares.delete(name);
      } else {
        this.waitingPrepares.set(name, left);
      }

      return this.prepareHostInTurn(request);
    });
  };

  private readonly prepareHostInTurn = async (request: HostRequest): Promise<void> => {
    const name = this.getImpName(request.host);
    const label = `atc-${request.daemonID}`;

    this.label = label;

    // A lease a running harness here already relies on stays held through a
    // failed prepare; only one this prepare took is given back.
    const held = this.hosts.get(request.host);
    const holdsLease = held !== undefined && (held.harnesses > 0 || held.renewTimer !== null);
    let created = false;
    let leased = false;
    const timer = request.timer ?? createStepTimer();

    try {
      const features = await timer.withStep('features', () => this.port.readFeatures());

      this.offsets = features.sessionOffsets;

      const existing = await timer.withStep('inspect-imp', () => this.port.readImp(name));

      if (existing === null) {
        this.imageATCVersions.delete(name);

        await timer.withStep('create-imp', () =>
          this.port.createImp(buildCreateImpSpec(name, this.target)),
        );

        created = true;
      }

      await timer.withStep('lease', () => this.port.acquireLease(name, label, this.leaseSeconds));

      leased = !holdsLease;

      await timer.withStep('guest-atc', () =>
        this.setupGuest(name, request.installATC === true, request.log ?? (() => {})),
      );
    } catch (error) {
      const undone = await this.tryUndoPrepare(name, label, created, leased);

      const refusal = toHostRefusal(error, name);

      if (!undone) {
        throw new EffectRemainsError(
          `imp ${name} failed to ready and destroying the imp it created failed too`,
          { cause: refusal },
        );
      }

      throw refusal;
    }

    const host = this.getHost(request.host);

    host.suspending = false;
    host.isIdle = request.isIdle ?? null;
    host.log = request.log ?? null;

    this.startRenewal(host, label);
  };

  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle => {
    const host = this.getHost(spec.host);

    host.harnesses += 1;

    const reporter = spec.onRelay === undefined ? null : this.openReporter(host, spec);

    return new ImpHarness(
      this.port,
      {
        kind: 'start',
        name: host.name,
        session: buildImpSessionName(spec.session),
        argv: [spec.bin, ...spec.args],
        env: {
          ...buildGuestEnv(spec.env),
          ...(reporter === null
            ? {}
            : buildSessionEnv({ socket: reporter.path, bridge: true, outbox: reporter.outbox })),
        },
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
        ...(spec.requireBroker === true ? { require: ['broker'] } : {}),
      },
      {
        offsets: this.offsets,
        reconnectDelaysMs: this.reconnectDelaysMs,
        ...(reporter === null ? {} : { ready: reporter.listening }),
        ...(spec.admit === undefined ? {} : { admit: spec.admit }),
        isSuspending: () => host.suspending,
        onDone: () => {
          reporter?.stop();
          host.harnesses -= 1;

          if (host.harnesses === 0 && !host.suspending) {
            void this.tryReleaseLease(host);
          }
        },
      },
    );
  };

  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive = async (archive: Uint8Array, dir: string, host?: string) => {
    // The archive crosses the network to impd, so it goes over gzipped:
    // imp-base ships gzip and no faster decompressor. An imp without gzip
    // refuses the transfer before it reads any input, and nothing falls back
    // to an uncompressed upload.
    const compressed = await gzipAsync(archive, { level: GZIP_LEVEL });

    // The archive records the daemon host's owners. Commands in an imp run as
    // root, and root's tar keeps those owners, which git there then refuses
    // as dubious ownership, so the unpacked files take the guest user's owner.
    const result = await this.runOnHost(host, {
      argv: ['sh', '-c', UNPACK_SCRIPT, 'sh', dir, String(NO_GZIP_CODE)],
      stdin: compressed,
    });

    if (result.code === NO_GZIP_CODE) {
      throw new Error(
        `imp ${this.getImpName(host ?? '')} has no gzip, which unpacking the archive into ${dir} needs; install gzip in its image`,
      );
    }

    if (result.code !== 0) {
      throw new Error(`tar exited ${result.code ?? 'by a signal'} unpacking into ${dir}`);
    }
  };

  readonly runCommand = async (spec: CommandSpec): Promise<CommandResult> => {
    const result = await this.runOnHost(spec.host, { argv: spec.argv, cwd: spec.cwd });

    const decoder = new TextDecoder();

    return {
      exitCode: result.code ?? 1,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  };

  // Gives back the daemon's own lease first, since a lease blocks a sleep,
  // then asks impd to sleep the imp without force. Another owner's lease
  // refuses the sleep: the daemon takes its lease back and the refusal
  // carries what impd showed of the other leases.
  readonly suspendHost = (hostKey: string, isIdle?: () => boolean): Promise<void> =>
    this.withHostTurn(this.getImpName(hostKey), async () => {
      const host = this.getHost(hostKey);

      // A host a harness runs on, or that a readying waits for, is busy.
      const isBusy = () =>
        isIdle !== undefined &&
        (!isIdle() || host.harnesses > 0 || (this.waitingPrepares.get(host.name) ?? 0) > 0);

      if (isBusy()) {
        throw buildBusyRefusal(host.name);
      }

      this.stopRenewal(host);

      host.suspending = true;

      try {
        if (this.label !== null) {
          await this.port.releaseLease(host.name, this.label);
        }

        if (isBusy()) {
          host.suspending = false;

          await this.restoreLease(host);

          throw buildBusyRefusal(host.name);
        }

        await this.port.suspendImp(host.name);
      } catch (error) {
        host.suspending = false;

        if (error instanceof ImpPortError && error.code === 'LEASED') {
          await this.restoreLease(host);

          throw buildLeasedRefusal(host.name, error.data);
        }

        throw toHostRefusal(error, host.name);
      }
    });

  // A destroy ends every lease on the imp with it.
  readonly destroyHost = async (hostKey: string): Promise<void> => {
    const host = this.hosts.get(hostKey);
    const name = this.getImpName(hostKey);

    if (host !== undefined) {
      this.stopRenewal(host);

      host.suspending = true;
    }

    try {
      await this.port.destroyImp(name);
    } catch (error) {
      if (!(error instanceof ImpPortError && error.code === 'NOT_FOUND')) {
        if (host !== undefined) {
          host.suspending = false;
        }

        throw toHostRefusal(error, name);
      }
    }

    this.hosts.delete(hostKey);
    this.imageATCVersions.delete(name);
  };

  readonly dispose = (): void => {
    for (const host of this.hosts.values()) {
      this.stopRenewal(host);
    }
  };

  // Takes back what a failed prepare left: an imp it created is destroyed,
  // which ends the lease on it too, since no session was ever listed on it;
  // on an imp that existed before, only the lease this prepare took is
  // given back, and the imp itself stays. Resolves to false when an imp it
  // created may still stand; a lease left behind runs out on its own.
  private async tryUndoPrepare(
    name: string,
    label: string,
    created: boolean,
    leased: boolean,
  ): Promise<boolean> {
    if (created) {
      try {
        await this.port.destroyImp(name);

        this.imageATCVersions.delete(name);

        return true;
      } catch (error) {
        return error instanceof ImpPortError && error.code === 'NOT_FOUND';
      }
    }

    if (leased) {
      await this.port.releaseLease(name, label).catch(() => false);
    }

    return true;
  }

  // Readies the folder the harnesses' report sockets live in, and readies
  // `bin/atc` when a harness needs atc: the image's atc when the target
  // sets one that runs the daemon's version, else the provider's atc
  // binary, copied in when the imp lacks it, as a cold boot of an imp
  // leaves it.
  private async setupGuest(
    name: string,
    installATC: boolean,
    log: (line: string) => void,
  ): Promise<void> {
    if (installATC && this.target.guestATC !== undefined) {
      await this.setupGuestATC(name, this.target.guestATC, log);

      return;
    }

    const ready = await this.port.runCommand(name, {
      argv: ['sh', '-c', READY_GUEST_DIR_SCRIPT, 'sh', this.guest.dir, this.guest.atc ?? ''],
    });

    if (ready.code === 0 || !installATC) {
      return;
    }

    if (this.atcBinary === null) {
      throw new DaemonError(
        'unsupported_operation',
        `imp ${name} has no executable atc at ${this.guest.atc ?? '(none)'}`,
        { provider: 'imp', problem: 'no_guest_atc' },
      );
    }

    await this.copyATCBinary(name, this.atcBinary);
  }

  // Points `bin/atc` at the image's atc when it runs the daemon's version,
  // and at a copy of the provider's atc binary otherwise, logging which.
  // The first readying of an imp reads the image's version in the same
  // command that links it; a later one links again or checks the copy.
  private async setupGuestATC(
    name: string,
    image: string,
    log: (line: string) => void,
  ): Promise<void> {
    const dir = this.guest.dir;
    const known = this.imageATCVersions.has(name);
    let imageVersion = this.imageATCVersions.get(name) ?? null;
    let copiedVersion: string | null = null;

    if (known && imageVersion === this.version) {
      const linked = await this.port.runCommand(name, {
        argv: ['sh', '-c', LINK_GUEST_ATC_SCRIPT, 'sh', dir, image],
      });

      if (linked.code !== 0) {
        throw new Error(
          `linking ${dir}/bin/atc to ${image} in ${name} exited ${linked.code ?? 'by a signal'}`,
        );
      }
    } else if (known) {
      const ready = await this.port.runCommand(name, {
        argv: ['sh', '-c', CHECK_GUEST_ATC_SCRIPT, 'sh', dir],
      });

      copiedVersion = ready.code === 0 ? this.version : null;
    } else {
      const read = await this.port.runCommand(name, {
        argv: ['sh', '-c', READ_GUEST_ATC_SCRIPT, 'sh', dir, image, this.version],
      });

      if (read.code !== 0) {
        throw new Error(`reading the atc versions in ${name} exited ${read.code ?? 'by a signal'}`);
      }

      const [readImage, readCopied] = new TextDecoder().decode(read.stdout).split('\n');

      imageVersion = readImage === undefined || readImage === '' ? null : readImage;
      copiedVersion = readCopied === undefined || readCopied === '' ? null : readCopied;
    }

    const found =
      imageVersion === null
        ? `the image has no executable atc at ${image}`
        : `the image's atc at ${image} is ${imageVersion}`;

    if (imageVersion === this.version) {
      this.imageATCVersions.set(name, imageVersion);

      log(`imp ${name} runs hooks through the image's atc ${this.version} at ${image}`);

      return;
    }

    if (copiedVersion === this.version) {
      this.imageATCVersions.set(name, imageVersion);

      log(
        `imp ${name} runs hooks through the daemon's atc ${this.version}, already at ${dir}/bin/atc: ${found}`,
      );

      return;
    }

    if (this.atcBinary === null) {
      throw new DaemonError(
        'unsupported_operation',
        `imp ${name} cannot run hooks through atc ${this.version}: ${found}, and a daemon run from source has no binary to copy in; install atc ${this.version} there, or run a compiled atc daemon on Linux`,
        { provider: 'imp', problem: 'no_guest_atc' },
      );
    }

    await this.copyATCBinary(name, this.atcBinary);

    this.imageATCVersions.set(name, imageVersion);

    log(
      `imp ${name} runs hooks through the daemon's atc ${this.version}, copied to ${dir}/bin/atc: ${found}`,
    );
  }

  // Copies the binary to `bin/atc`, replacing a link to the image's atc.
  private async copyATCBinary(name: string, atcBinary: string): Promise<void> {
    const binary = await Bun.file(atcBinary).bytes();

    const unpacked = await this.port.runCommand(name, {
      argv: ['sh', '-c', INSTALL_GUEST_ATC_SCRIPT, 'sh', this.guest.dir],
      stdin: buildTarArchive([{ path: 'bin/atc', content: binary, mode: 0o755 }]),
    });

    if (unpacked.code !== 0) {
      throw new Error(`tar exited ${unpacked.code ?? 'by a signal'} installing atc in ${name}`);
    }
  }

  // A socket inside the imp that serves one harness: each connection a
  // process opens there reaches the daemon as that harness's relay, and
  // nothing else reaches the daemon through it. impd ends a forward for
  // good when its tunnel socket closes while the harness keeps running, so
  // a forward that ends before the harness does listens again on the same
  // path, after the provider's reconnect delays, until the harness ends.
  // Hooks that run in between find no socket and are lost. A forward the
  // imp's sleep ended stays ended, since a listen wakes a sleeping imp; the
  // harness a wake revives opens a forward of its own.
  private openReporter(host: ImpHost, spec: HarnessSpec) {
    const base = `${this.guest.dir}/run/${buildSocketName(spec.session)}`;
    const path = `${base}.sock`;
    const onRelay = spec.onRelay;

    const stopping = new AbortController();

    const openForward = () =>
      this.port.openReverseForward(host.name, path, (connection) => {
        onRelay?.(toHarnessRelay(connection));
      });

    let current = openForward();

    const restoreForward = async (): Promise<void> => {
      let failures = 0;

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- each forward is watched only once the one before it ended
        const end = await current.ended;

        if (stopping.signal.aborted || end.kind === 'stopped' || host.suspending) {
          return;
        }

        if (end.kind === 'lost') {
          host.log?.(
            `imp ${host.name} stopped listening for session ${spec.session}'s hooks (${formatForwardEnd(end)}); a wake listens again`,
          );

          return;
        }

        const delay =
          this.reconnectDelaysMs[Math.min(failures, this.reconnectDelaysMs.length - 1)] ?? 0;

        failures += 1;

        host.log?.(
          `imp ${host.name} stopped listening for session ${spec.session}'s hooks (${formatForwardEnd(end)}); listening again in ${delay}ms`,
        );

        try {
          // oxlint-disable-next-line no-await-in-loop -- the wait between one forward and the next
          await sleep(delay, undefined, { signal: stopping.signal, ref: false });
        } catch {
          return;
        }

        current = openForward();

        try {
          // oxlint-disable-next-line no-await-in-loop -- a forward that listens resets the delays
          await current.listening;

          failures = 0;
        } catch {
          // Its end follows, and takes the next delay.
        }
      }
    };

    void restoreForward();

    // Notes and answers the guest has not seen answered wait in the outbox beside
    // the socket, for the next connection to send again.
    return {
      path,
      outbox: `${base}.outbox`,
      listening: current.listening,
      stop: () => {
        stopping.abort();
        current.stop();
      },
    };
  }

  private async runOnHost(
    hostKey: string | undefined,

    // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
    command: Readonly<{ argv: readonly string[]; cwd?: string; stdin?: Uint8Array }>,
  ) {
    if (hostKey === undefined) {
      throw new Error('the imp provider runs a command only on a session host');
    }

    try {
      return await this.port.runCommand(this.getImpName(hostKey), command);
    } catch (error) {
      throw toHostRefusal(error, this.getImpName(hostKey));
    }
  }

  // A renewal that finds the lease gone, as a forced sleep leaves it, stops
  // renewing: the daemon never takes a lease back behind an owner who ended
  // it. A host with no harness left gives its lease back.
  private startRenewal(host: ImpHost, label: string): void {
    if (host.renewTimer !== null) {
      return;
    }

    host.renewTimer = setInterval(
      () => {
        void this.refreshLease(host, label);
      },
      (this.leaseSeconds * 1000) / 3,
    );

    host.renewTimer.unref();
  }

  private async tryRenewLease(host: ImpHost, label: string): Promise<boolean> {
    try {
      await this.port.renewLease(host.name, label, this.leaseSeconds);
    } catch (error) {
      if (error instanceof ImpPortError && error.code === 'LEASE_NOT_HELD') {
        this.stopRenewal(host);
      }

      return false;
    }

    return true;
  }

  private stopRenewal(host: ImpHost): void {
    if (host.renewTimer !== null) {
      clearInterval(host.renewTimer);

      host.renewTimer = null;
    }
  }

  private async restoreLease(host: ImpHost): Promise<void> {
    if (this.label === null) {
      return;
    }

    try {
      await this.port.acquireLease(host.name, this.label, this.leaseSeconds);
    } catch {
      return;
    }

    this.startRenewal(host, this.label);
  }

  // A host with no harness gives its lease back, unless a launch readies it,
  // which keeps the lease renewed.
  private async refreshLease(host: ImpHost, label: string): Promise<void> {
    if (host.harnesses === 0) {
      const released = await this.tryReleaseLease(host);

      if (released) {
        return;
      }
    }

    if (host.renewTimer !== null) {
      await this.tryRenewLease(host, label);
    }
  }

  // Gives an imp's lease back once nothing runs or starts there, in the
  // imp's turn, so it never drops a lease a readying took for a launch.
  private tryReleaseLease(host: ImpHost): Promise<boolean> {
    return this.withHostTurn(host.name, async () => {
      const isBusy =
        host.harnesses > 0 ||
        host.suspending ||
        (this.waitingPrepares.get(host.name) ?? 0) > 0 ||
        host.isIdle?.() === false;

      if (isBusy || this.label === null) {
        return false;
      }

      this.stopRenewal(host);

      try {
        return await this.port.releaseLease(host.name, this.label);
      } catch {
        return false;
      }
    });
  }
}

// What the provider follows of one imp: its name, how many harnesses run
// there, the renewal holding the daemon's lease, and whether a sleep or a
// destroy the provider asked for is ending its connections.
interface ImpHost {
  readonly name: string;
  harnesses: number;
  renewTimer: ReturnType<typeof setInterval> | null;
  suspending: boolean;

  // The daemon's check that nothing runs or starts on the host, from its
  // latest readying; null until one gives it.
  isIdle: (() => boolean) | null;

  // Where the latest readying asked the provider to report, or null.
  log: ((line: string) => void) | null;
}

// The imp a target creates: its image and memory when the target sets them,
// and impd's defaults otherwise.
function buildCreateImpSpec(name: string, target: ImpTargetOptions): ImpCreateSpec {
  return {
    name,
    ...(target.image === undefined ? {} : { image: target.image }),
    ...(target.memoryMib === undefined ? {} : { memoryMib: target.memoryMib }),
  };
}

function formatForwardEnd(end: Exclude<ImpForwardEnd, { kind: 'stopped' }>): string {
  return match(end)
    .with({ kind: 'lost' }, () => 'the imp went away')
    .with({ kind: 'closed' }, (closed) =>
      closed.reason === '' ? `closed ${closed.code}` : `closed ${closed.code}: ${closed.reason}`,
    )
    .with(
      { kind: 'failed' },
      (failed) => `refused ${failed.code ?? 'without a code'}: ${failed.message}`,
    )
    .exhaustive();
}

function buildImpSessionName(sessionID: string): string {
  // The prefix plus 28 chars stays inside the 32-char session limit.
  return `atc-${buildShortName(sessionID, 28)}`;
}

// Short enough that the socket's path stays inside a unix socket's limit.
function buildSocketName(sessionID: string): string {
  return buildShortName(sessionID, 16);
}

// Frames a guest connection's bytes into lines, both ways.
function toHarnessRelay(connection: ImpRelayConnection): HarnessRelay {
  const decoder = new LineDecoder();
  const encoder = new TextEncoder();

  const lineListeners: ((line: string) => void)[] = [];

  connection.onData((data) => {
    for (const line of decoder.splitChunk(data)) {
      for (const listener of lineListeners) {
        listener(line);
      }
    }
  });

  return {
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      connection.onClose(listener);
    },
    writeLine: (line) => connection.write(encoder.encode(`${line}\n`)),
    close: () => {
      connection.close();
    },
  };
}

// The binary the provider copies into an imp: the running daemon itself
// when it is a compiled Linux binary, since an imp runs Linux.
function findOwnLinuxBinary(): string | null {
  return isCompiledBinary() && process.platform === 'linux' ? process.execPath : null;
}

// A guest harness gets the variables atc sets for it and the guest's own
// terminal, locale, and PATH, never the daemon's environment. The daemon's
// reporter socket path means nothing inside the imp.
function buildGuestEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const own = Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== SESSION_ENV_NAMES.socket),
  );

  return { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: GUEST_PATH, ...own };
}

function buildBusyRefusal(name: string): DaemonError {
  return new DaemonError(
    'host_unavailable',
    `imp ${name} stays awake: a session runs there or is starting there`,
    { provider: 'imp', problem: 'busy' },
  );
}

// The leases that impd's refusal to suspend a leased imp holds: those the
// caller may see, and a count of the others, each read on its own.
const LEASES_SCHEMA = z.object({ leases: z.array(z.unknown()) });
const OTHER_COUNT_SCHEMA = z.object({ otherCount: z.number() });

function buildLeasedRefusal(name: string, data: unknown): DaemonError {
  const leases = LEASES_SCHEMA.safeParse(data).data?.leases ?? [];
  const otherCount = OTHER_COUNT_SCHEMA.safeParse(data).data?.otherCount ?? 0;

  return new DaemonError(
    'host_leased',
    `imp ${name} stays awake: another owner holds a lease on it, and atc never forces a sleep`,
    { leases, otherCount },
  );
}

function toHostRefusal(error: unknown, name: string): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  const code = error instanceof ImpPortError ? error.code : 'UNKNOWN';
  const detail = error instanceof Error ? error.message : String(error);

  return new DaemonError('host_unavailable', `imp ${name} cannot be used: ${detail}`, {
    provider: 'imp',
    problem: code.toLowerCase(),
  });
}
