import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { isCompiledBinary } from '@atc/config/host';
import { createStepTimer, makeKeyedLock } from '@atc/core';
import type {
  CredentialBroker,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HostRequest,
} from '@atc/plugin-api';
import { EffectRemainsError, isHostNameAllowed } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { buildBusyRefusal } from './build-busy-refusal';
import { buildGuestEnv } from './build-guest-env';
import { buildHomeRelativeCommand } from './build-home-relative-command';
import { buildImpCredentialBroker } from './build-imp-credential-broker';
import { buildImpName } from './build-imp-name';
import { buildLeasedRefusal } from './build-leased-refusal';
import { buildShortName } from './build-short-name';
import { createImpGuestATC } from './create-imp-guest-atc';
import { createImpHarness } from './create-imp-harness';
import { createImpLeases } from './create-imp-leases';
import type { ImpHost } from './imp-host';
import type { ImpCreateSpec, ImpPort } from './imp-port';
import { ImpPortError } from './imp-port-error';
import { NO_GZIP_CODE } from './no-gzip-code';
import { openReporter } from './open-reporter';
import { toHostRefusal } from './to-host-refusal';
import UNPACK_SCRIPT from './unpack-archive.sh' with { type: 'text' };

export interface ImpProvider extends ExecutionProvider {
  readonly kind: 'imp';

  readonly guest: GuestLayout;

  // The literal start of every imp name this provider builds: the runtime
  // namespace an impd token's imp patterns are checked against.
  readonly impPrefix: string;

  readonly brokerAuth: CredentialBroker;

  readonly rebindChangedAuth: boolean;

  // The imp a host key runs on, under this provider's prefix.
  readonly getImpName: (hostKey: string) => string;

  readonly checkExistingHost: (host: string) => Promise<boolean>;

  // An imp whose agent booted before read-only files has no such place,
  // which a later cold boot of the imp gives it.
  readonly writeReadOnlyFile: (
    hostKey: string,
    path: string,
    content: string,
  ) => Promise<string | null>;
}

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

export function createImpProvider(
  port: ImpPort,
  target: ImpTargetOptions,
  options: ImpProviderOptions,
): ImpProvider {
  const capabilities: ExecutionCapabilities = {
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

  const hosts = new Map<string, ImpHost>();

  // Each imp's readyings, sleeps, and lease returns run one after another,
  // in the order they were asked for, so none of them gives back the lease
  // a readying just took.
  const withHostTurn = makeKeyedLock();

  // The readyings of each imp still waiting for their turn.
  const waitingPrepares = new Map<string, number>();

  const impPrefix = target.impPrefix ?? IMP_PREFIX;
  const rebindChangedAuth = target.rebindChangedAuth ?? false;
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const atcBinary = options.atcBinary === undefined ? findOwnLinuxBinary() : options.atcBinary;
  const directory = target.guestDir ?? GUEST_DIR;

  // Hooks always run `bin/atc`, since a session's hooks are planned before
  // its imp is readied and the readying decides what that path holds.
  const guest: GuestLayout = {
    directory,
    atc: target.guestATC === undefined && atcBinary === null ? null : `${directory}/bin/atc`,
  };

  const guestATC = createImpGuestATC({
    port,
    guest,
    guestATC: target.guestATC,
    atcBinary,
    version: options.version,
  });

  const leases = createImpLeases({
    port,
    leaseSeconds,
    withHostTurn,
    waitingPrepares,
  });

  const getImpName = (hostKey: string): string => buildImpName(impPrefix, hostKey);

  // The provider's record of a host, made and kept on the first ask.
  const getHost = (hostKey: string): ImpHost => {
    const host = hosts.get(hostKey) ?? {
      name: getImpName(hostKey),
      harnesses: 0,
      renewTimer: null,
      suspending: false,
      isIdle: null,
      log: null,
      sleepRefusals: new Set(),
    };

    hosts.set(hostKey, host);

    return host;
  };

  // An imp this prepare created is destroyed, which ends its lease too; on an
  // imp that existed before, only the lease goes back. False when a created imp
  // may still stand.
  const tryUndoPrepare = async (
    name: string,
    label: string,
    created: boolean,
    leased: boolean,
  ): Promise<boolean> => {
    if (created) {
      try {
        await port.destroyImp(name);

        guestATC.removeImageVersion(name);

        return true;
      } catch (error) {
        return error instanceof ImpPortError && error.code === 'NOT_FOUND';
      }
    }

    if (leased) {
      await port.releaseLease(name, label).catch(() => false);
    }

    return true;
  };

  const prepareHostInTurn = async (request: HostRequest): Promise<void> => {
    const name = getImpName(request.host);
    const label = `atc-${request.daemonID}`;

    leases.label = label;

    // A lease a running harness here already relies on stays held through a
    // failed prepare; only one this prepare took is given back.
    const held = hosts.get(request.host);
    const holdsLease = held !== undefined && (held.harnesses > 0 || held.renewTimer !== null);
    let created = false;
    let leased = false;
    const timer = request.timer ?? createStepTimer();

    try {
      await timer.withStep('impd-version', () => port.verifyVersion());

      const existing = await timer.withStep('inspect-imp', () => port.readImp(name));

      if (existing === null) {
        guestATC.removeImageVersion(name);

        await timer.withStep('create-imp', () => port.createImp(buildCreateImpSpec(name, target)));

        created = true;
      }

      await timer.withStep('lease', () => port.acquireLease(name, label, leaseSeconds));

      leased = !holdsLease;

      await timer.withStep('guest-atc', () =>
        guestATC.setupGuest(name, request.installATC === true, request.log ?? (() => {})),
      );
    } catch (error) {
      const undone = await tryUndoPrepare(name, label, created, leased);

      const refusal = toHostRefusal(error, name);

      if (!undone) {
        throw new EffectRemainsError(
          `imp ${name} failed to ready and destroying the imp it created failed too`,
          { cause: refusal },
        );
      }

      throw refusal;
    }

    const host = getHost(request.host);

    host.suspending = false;
    host.isIdle = request.isIdle ?? null;
    host.log = request.log ?? null;

    leases.startRenewal(host, label);
  };

  const runOnHost = async (
    hostKey: string | undefined,

    command: Readonly<{ argv: readonly string[]; cwd?: string; stdin?: Uint8Array }>,
  ) => {
    if (hostKey === undefined) {
      throw new Error('the imp provider runs a command only on a session host');
    }

    try {
      return await port.runCommand(getImpName(hostKey), command);
    } catch (error) {
      throw toHostRefusal(error, getImpName(hostKey));
    }
  };

  // A destroy ends every lease on the imp with it.
  const destroyHost = async (hostKey: string): Promise<void> => {
    const host = hosts.get(hostKey);
    const name = getImpName(hostKey);

    if (host !== undefined) {
      leases.stopRenewal(host);

      host.suspending = true;
    }

    try {
      await port.destroyImp(name);
    } catch (error) {
      if (!(error instanceof ImpPortError && error.code === 'NOT_FOUND')) {
        if (host !== undefined) {
          host.suspending = false;

          emitSleepRefusal(host);
        }

        throw toHostRefusal(error, name);
      }
    }

    hosts.delete(hostKey);
    guestATC.removeImageVersion(name);
  };

  const brokerAuth = buildImpCredentialBroker(port, {
    impPrefix,
    getImpName: (hostKey) => getImpName(hostKey),
    createImp: (hostKey) => port.createImp(buildCreateImpSpec(getImpName(hostKey), target)),
    destroyImp: (hostKey) => destroyHost(hostKey),
  });

  return {
    kind: 'imp',

    remote: true,

    // An imp fetches from the repository host over its own network, and its
    // image holds no git identity, so a checkout takes the daemon host's.
    cloneOnTarget: true,

    hostGitIdentity: true,

    guestWorkspaceTrust: true,

    capabilities,

    guest,

    impPrefix,

    brokerAuth,

    rebindChangedAuth,

    getImpName,

    checkExistingHost: async (host) => {
      try {
        const name = getImpName(host);

        const identity = await port.readIdentity();

        if (
          identity.scope === 'read' ||
          (identity.imps !== null && !isHostNameAllowed(identity.imps, name))
        ) {
          return false;
        }

        return (await port.readImp(name)) !== null;
      } catch {
        return false;
      }
    },

    // Creates the host's imp when impd holds none, then takes the daemon's
    // lease, which boots or wakes the imp.
    prepareHost: (request) => {
      const name = getImpName(request.host);

      waitingPrepares.set(name, (waitingPrepares.get(name) ?? 0) + 1);

      return withHostTurn(name, () => {
        const left = (waitingPrepares.get(name) ?? 1) - 1;

        if (left === 0) {
          waitingPrepares.delete(name);
        } else {
          waitingPrepares.set(name, left);
        }

        return prepareHostInTurn(request);
      });
    },

    spawnHarness: (spec) => {
      const host = getHost(spec.host);

      host.harnesses += 1;

      const reporter =
        spec.onRelay === undefined
          ? null
          : openReporter(
              {
                port,
                guestDir: guest.directory,
                reconnectDelaysMs,
              },
              host,
              spec,
            );

      const command = buildHomeRelativeCommand([spec.bin, ...spec.args], spec.cwd);

      return createImpHarness(
        port,
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
          ...(target.dropSysAdmin === true ? { dropSysAdmin: true } : {}),
        },
        {
          reconnectDelaysMs,
          ...(reporter === null ? {} : { ready: reporter.listening }),
          ...(spec.admit === undefined ? {} : { admit: spec.admit }),
          isSuspending: () => host.suspending,
          onDone: () => {
            reporter?.stop();
            host.harnesses -= 1;

            if (host.harnesses === 0 && !host.suspending) {
              void leases.tryReleaseLease(host);
            }
          },
        },
      );
    },

    transferArchive: async (archive, archiveDirectory, host) => {
      // The archive crosses the network, so it goes gzipped: imp-base ships gzip and
      // no faster decompressor, and nothing falls back to an uncompressed upload.
      const compressed = await gzipAsync(archive, { level: GZIP_LEVEL });

      // The archive records the daemon host's owners. Commands in an imp run as
      // root, and root's tar keeps those owners, which git there then refuses
      // as dubious ownership, so the unpacked files take the guest user's owner.
      const result = await runOnHost(host, {
        argv: ['sh', '-c', UNPACK_SCRIPT, 'sh', archiveDirectory, String(NO_GZIP_CODE)],
        stdin: compressed,
      });

      if (result.code === NO_GZIP_CODE) {
        throw new Error(
          `imp ${getImpName(host ?? '')} has no gzip, which unpacking the archive into ${archiveDirectory} needs; install gzip in its image`,
        );
      }

      if (result.code !== 0) {
        throw new Error(
          `tar exited ${result.code ?? 'by a signal'} unpacking into ${archiveDirectory}`,
        );
      }
    },

    runCommand: async (spec) => {
      const result = await runOnHost(spec.host, buildHomeRelativeCommand(spec.argv, spec.cwd));

      const decoder = new TextDecoder();

      return {
        exitCode: result.code ?? 1,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },

    writeReadOnlyFile: async (hostKey, path, content) => {
      const name = getImpName(hostKey);

      try {
        return await port.writeReadOnlyFile(name, path, content);
      } catch (error) {
        if (error instanceof ImpPortError && error.code === 'AGENT_OUTDATED') {
          return null;
        }

        throw toHostRefusal(error, name);
      }
    },

    // A lease blocks a sleep, so the daemon's own goes back first and the sleep
    // never forces. Another owner's lease refuses it, and the daemon takes its
    // lease back.
    suspendHost: (hostKey, isIdle) =>
      withHostTurn(getImpName(hostKey), async () => {
        const host = getHost(hostKey);

        // A host a harness runs on, or that a readying waits for, is busy.
        const isBusy = () =>
          isIdle !== undefined &&
          (!isIdle() || host.harnesses > 0 || (waitingPrepares.get(host.name) ?? 0) > 0);

        if (isBusy()) {
          throw buildBusyRefusal(host.name);
        }

        leases.stopRenewal(host);

        host.suspending = true;

        try {
          if (leases.label !== null) {
            await port.releaseLease(host.name, leases.label);
          }

          if (isBusy()) {
            host.suspending = false;

            emitSleepRefusal(host);

            await leases.restoreLease(host);

            throw buildBusyRefusal(host.name);
          }

          await port.suspendImp(host.name);
        } catch (error) {
          host.suspending = false;

          emitSleepRefusal(host);

          if (error instanceof ImpPortError && error.code === 'LEASED') {
            await leases.restoreLease(host);

            throw buildLeasedRefusal(host.name, error.data);
          }

          throw toHostRefusal(error, host.name);
        }
      }),

    destroyHost,

    dispose: () => {
      for (const host of hosts.values()) {
        leases.stopRenewal(host);
      }
    },
  };
}

// The binary the provider copies into an imp: the running daemon itself
// when it is a compiled Linux binary, since an imp runs Linux.
function findOwnLinuxBinary(): string | null {
  return isCompiledBinary() && process.platform === 'linux' ? process.execPath : null;
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
