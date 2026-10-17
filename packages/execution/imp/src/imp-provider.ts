import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { isCompiledBinary } from '@atc/config/host';
import { createStepTimer, makeKeyedLock } from '@atc/core';
import type {
  CommandResult,
  CommandSpec,
  CredentialBroker,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessHandle,
  HarnessSpec,
  HostRequest,
} from '@atc/plugin-api';
import { EffectRemainsError, isHostNameAllowed } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { buildBusyRefusal } from './build-busy-refusal';
import { buildGuestEnv } from './build-guest-env';
import { buildHomeRelativeCommand } from './build-home-relative-command';
import { buildImpCredentialBroker } from './build-imp-credential-broker';
import { buildImpName } from './build-imp-name';
import { buildLeasedRefusal } from './build-leased-refusal';
import { buildShortName } from './build-short-name';
import { ImpGuestATC } from './imp-guest-atc';
import { ImpHarness } from './imp-harness';
import type { ImpHost } from './imp-host';
import { ImpLeases } from './imp-leases';
import type { ImpCreateSpec, ImpPort } from './imp-port';
import { ImpPortError } from './imp-port-error';
import { NO_GZIP_CODE } from './no-gzip-code';
import { openReporter } from './open-reporter';
import { toHostRefusal } from './to-host-refusal';
import UNPACK_SCRIPT from './unpack-archive.sh' with { type: 'text' };

interface ImpTargetOptions {
  readonly impPrefix?: string;
  readonly rebindChangedAuth?: boolean;
  readonly dropSysAdmin?: boolean;
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
const gzipAsync = promisify(gzip);

// Level 2 keeps nearly all of level 6's ratio on a workspace tar at about
// two thirds of its CPU time.
const GZIP_LEVEL = 2;

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

  private readonly guestATC: ImpGuestATC;

  private readonly leases: ImpLeases;

  // Whether impd carries output offsets, once a prepare has read its
  // features; an impd without the flag carries none.
  private offsets = false;

  // Whether impd writes read-only files, once a prepare has read its
  // features; an impd without the flag writes none.
  private readOnlyFiles = false;

  constructor(port: ImpPort, target: ImpTargetOptions, options: ImpProviderOptions) {
    this.port = port;
    this.target = target;
    this.impPrefix = target.impPrefix ?? IMP_PREFIX;
    this.rebindChangedAuth = target.rebindChangedAuth ?? false;
    this.leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;

    const atcBinary = options.atcBinary === undefined ? findOwnLinuxBinary() : options.atcBinary;
    const dir = target.guestDir ?? GUEST_DIR;

    // Hooks always run `bin/atc`, since a session's hooks are planned before
    // its imp is readied and the readying decides what that path holds.
    this.guest = {
      dir,
      atc: target.guestATC === undefined && atcBinary === null ? null : `${dir}/bin/atc`,
    };

    this.guestATC = new ImpGuestATC({
      port,
      guest: this.guest,
      guestATC: target.guestATC,
      atcBinary,
      version: options.version,
    });

    this.leases = new ImpLeases({
      port,
      leaseSeconds: this.leaseSeconds,
      withHostTurn: this.withHostTurn,
      waitingPrepares: this.waitingPrepares,
    });

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
      sleepRefusals: new Set(),
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

    this.leases.label = label;

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
      this.readOnlyFiles = features.readOnlyFiles;

      // an impd without the feature drops the field and would start the
      // harness with the capability
      if (this.target.dropSysAdmin === true && !features.execDropSysAdmin) {
        throw new DaemonError(
          'host_unavailable',
          `imp ${name} cannot be used: impd cannot start a harness without CAP_SYS_ADMIN, which this target's dropSysAdmin asks for`,
          { provider: 'imp', problem: 'impd_outdated' },
        );
      }

      const existing = await timer.withStep('inspect-imp', () => this.port.readImp(name));

      if (existing === null) {
        this.guestATC.removeImageVersion(name);

        await timer.withStep('create-imp', () =>
          this.port.createImp(buildCreateImpSpec(name, this.target)),
        );

        created = true;
      }

      await timer.withStep('lease', () => this.port.acquireLease(name, label, this.leaseSeconds));

      leased = !holdsLease;

      await timer.withStep('guest-atc', () =>
        this.guestATC.setupGuest(name, request.installATC === true, request.log ?? (() => {})),
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

    this.leases.startRenewal(host, label);
  };

  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle => {
    const host = this.getHost(spec.host);

    host.harnesses += 1;

    const reporter =
      spec.onRelay === undefined
        ? null
        : openReporter(
            {
              port: this.port,
              guestDir: this.guest.dir,
              reconnectDelaysMs: this.reconnectDelaysMs,
            },
            host,
            spec,
          );

    const command = buildHomeRelativeCommand([spec.bin, ...spec.args], spec.cwd);

    return new ImpHarness(
      this.port,
      {
        kind: 'start',
        name: host.name,
        session: buildImpSessionName(spec.session),
        argv: command.argv,
        env: {
          ...buildGuestEnv(spec.env),
          ...(reporter === null
            ? {}
            : buildSessionEnv({ socket: reporter.path, bridge: true, outbox: reporter.outbox })),
        },
        cwd: command.cwd,
        cols: spec.cols,
        rows: spec.rows,
        ...(spec.requireBroker === true ? { require: ['broker'] } : {}),
        ...(this.target.dropSysAdmin === true ? { dropSysAdmin: true } : {}),
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
            void this.leases.tryReleaseLease(host);
          }
        },
      },
    );
  };

  readonly transferArchive = async (archive: Uint8Array, dir: string, host?: string) => {
    // The archive crosses the network, so it goes gzipped: imp-base ships gzip and
    // no faster decompressor, and nothing falls back to an uncompressed upload.
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
    const result = await this.runOnHost(spec.host, buildHomeRelativeCommand(spec.argv, spec.cwd));

    const decoder = new TextDecoder();

    return {
      exitCode: result.code ?? 1,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  };

  // An impd without read-only files, or an imp whose agent booted before
  // them, has no such place, which a later cold boot of the imp gives it.
  readonly writeReadOnlyFile = async (
    hostKey: string,
    path: string,
    content: string,
  ): Promise<string | null> => {
    if (!this.readOnlyFiles) {
      return null;
    }

    const name = this.getImpName(hostKey);

    try {
      return await this.port.writeReadOnlyFile(name, path, content);
    } catch (error) {
      if (error instanceof ImpPortError && error.code === 'AGENT_OUTDATED') {
        return null;
      }

      throw toHostRefusal(error, name);
    }
  };

  // A lease blocks a sleep, so the daemon's own goes back first and the sleep
  // never forces. Another owner's lease refuses it, and the daemon takes its
  // lease back.
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

      this.leases.stopRenewal(host);

      host.suspending = true;

      try {
        if (this.leases.label !== null) {
          await this.port.releaseLease(host.name, this.leases.label);
        }

        if (isBusy()) {
          host.suspending = false;

          emitSleepRefusal(host);

          await this.leases.restoreLease(host);

          throw buildBusyRefusal(host.name);
        }

        await this.port.suspendImp(host.name);
      } catch (error) {
        host.suspending = false;

        emitSleepRefusal(host);

        if (error instanceof ImpPortError && error.code === 'LEASED') {
          await this.leases.restoreLease(host);

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
      this.leases.stopRenewal(host);

      host.suspending = true;
    }

    try {
      await this.port.destroyImp(name);
    } catch (error) {
      if (!(error instanceof ImpPortError && error.code === 'NOT_FOUND')) {
        if (host !== undefined) {
          host.suspending = false;

          emitSleepRefusal(host);
        }

        throw toHostRefusal(error, name);
      }
    }

    this.hosts.delete(hostKey);
    this.guestATC.removeImageVersion(name);
  };

  readonly dispose = (): void => {
    for (const host of this.hosts.values()) {
      this.leases.stopRenewal(host);
    }
  };

  // An imp this prepare created is destroyed, which ends its lease too; on an
  // imp that existed before, only the lease goes back. False when a created imp
  // may still stand.
  private async tryUndoPrepare(
    name: string,
    label: string,
    created: boolean,
    leased: boolean,
  ): Promise<boolean> {
    if (created) {
      try {
        await this.port.destroyImp(name);

        this.guestATC.removeImageVersion(name);

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

  private async runOnHost(
    hostKey: string | undefined,

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

function emitSleepRefusal(host: ImpHost): void {
  const listeners = [...host.sleepRefusals];

  host.sleepRefusals.clear();

  for (const listener of listeners) {
    listener();
  }
}

function buildImpSessionName(sessionID: string): string {
  // The prefix plus 28 chars stays inside the 32-char session limit.
  return `atc-${buildShortName(sessionID, 28)}`;
}

// The binary the provider copies into an imp: the running daemon itself
// when it is a compiled Linux binary, since an imp runs Linux.
function findOwnLinuxBinary(): string | null {
  return isCompiledBinary() && process.platform === 'linux' ? process.execPath : null;
}
