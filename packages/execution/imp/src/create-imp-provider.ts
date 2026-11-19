import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createStepTimer, makeKeyedLock } from '@atc/core';
import type {
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessSpec,
  HostCredentials,
  HostFact,
  HostRequest,
} from '@atc/plugin-api';
import { EffectRemainsError, isHostNameAllowed } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import invariant from 'tiny-invariant';
import { buildImpCredentialBroker } from './auth/build-imp-credential-broker';
import { buildGuestEnv } from './guest-atc/build-guest-env';
import { buildHomeRelativeCommand } from './guest-atc/build-home-relative-command';
import { createImpGuestATC } from './guest-atc/create-imp-guest-atc';
import { NO_GZIP_CODE } from './guest-atc/no-gzip-code';
import UNPACK_SCRIPT from './guest-atc/unpack-archive.sh' with { type: 'text' };
import { createImpHarness } from './harness/create-imp-harness';
import { IMPD_UPGRADE } from './impd/impd-upgrade';
import type { ImpHost } from './port/imp-host';
import type { ImpPort } from './port/imp-port';
import { ImpPortError } from './port/imp-port-error';
import { buildBusyRefusal } from './provider/build-busy-refusal';
import { buildCreateImpSpec } from './provider/build-create-imp-spec';
import { buildImpName } from './provider/build-imp-name';
import { buildImpSessionName } from './provider/build-imp-session-name';
import { buildLeasedRefusal } from './provider/build-leased-refusal';
import { createImpLeases } from './provider/create-imp-leases';
import { emitSleepRefusal } from './provider/emit-sleep-refusal';
import { findOwnLinuxBinary } from './provider/find-own-linux-binary';
import { openReporter } from './provider/open-reporter';
import { toHostRefusal } from './provider/to-host-refusal';
import type { ImpProviderOptions, ImpTargetOptions } from './provider/types';

export interface ImpProvider extends ExecutionProvider {
  readonly kind: 'imp';

  readonly readGuest: (hostKey: string) => Promise<GuestLayout>;

  // An impd token's imp patterns are checked against this prefix as the imps' runtime namespace.
  readonly impPrefix: string;

  readonly credentials: Extract<HostCredentials, { readonly kind: 'broker' }>;

  readonly getImpName: (hostKey: string) => string;

  readonly checkExistingHost: (host: string) => Promise<boolean>;

  readonly findHostFact: (host: string) => HostFact;

  // An imp creates the place that holds read-only files only at cold boot, so an agent on an
  // imp booted without that place has nowhere to put them until the imp cold boots again.
  readonly writeReadOnlyFile: (
    hostKey: string,
    path: string,
    content: string,
  ) => Promise<string | null>;

  readonly dispose: () => void;
}

const GUEST_FOLDER = 'atc';
const IMP_PREFIX = 'atc-';

// impd takes a lease of 10 to 3600 seconds; the daemon renews at a third of it.
const LEASE_SECONDS = 600;
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
    relay: true,
  };

  const hosts = new Map<string, ImpHost>();

  // Each imp's readyings, sleeps, and lease returns run one after another,
  // in the order they were asked for, so none of them gives back the lease
  // a readying just took.
  const withHostTurn = makeKeyedLock();

  const waitingPrepares = new Map<string, number>();

  const impPrefix = target.impPrefix ?? IMP_PREFIX;
  const rebindChangedAuth = target.rebindChangedAuth ?? false;
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const atcBinary = options.atcBinary === undefined ? findOwnLinuxBinary() : options.atcBinary;
  const hasGuestATC = target.guestATC !== undefined || atcBinary !== null;

  // impd gives a new id to an imp made again under an old name, so a readying that finds no imp
  // drops the stored id before it creates one; otherwise the new imp would show the old id.
  const impIDs = new Map<string, string>();

  let issuer: string | null = null;

  // impd's scratch folder changes only with impd's own config, so the first
  // read holds for the provider's life.
  let guest: GuestLayout | null = null;

  // Hooks always run `bin/atc`, since a session's hooks are planned before
  // its imp is readied and the readying decides what that path holds.
  const readLayout = async (): Promise<GuestLayout> => {
    if (guest !== null) {
      return guest;
    }

    const directory = target.guestDir ?? `${await port.readGuestScratchDir()}/${GUEST_FOLDER}`;

    guest = { directory, atc: hasGuestATC ? `${directory}/bin/atc` : null, signIn: null };

    return guest;
  };

  const guestATC = createImpGuestATC({
    port,
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

  // Destroying an imp also ends its lease, so an imp created here needs no separate lease release.
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
      const layout = await timer.withStep('impd-version', async () => {
        await port.verifyVersion().catch((error: unknown) => {
          throw error instanceof ImpPortError && error.code === 'IMPD_OUTDATED'
            ? new ImpPortError(error.code, `${error.message}; ${IMPD_UPGRADE}`, error.data)
            : error;
        });

        return readLayout();
      });

      issuer = await port.readIssuer();

      const existing = await timer.withStep('inspect-imp', () => port.readImp(name));

      if (existing === null) {
        guestATC.removeImageVersion(name);
        impIDs.delete(name);

        const made = await timer.withStep('create-imp', () =>
          port.createImp(buildCreateImpSpec(name, target)),
        );

        created = true;

        impIDs.set(name, made.id);
      } else {
        impIDs.set(name, existing.id);
      }

      await timer.withStep('lease', () => port.acquireLease(name, label, leaseSeconds));

      leased = !holdsLease;

      await timer.withStep('guest-atc', () =>
        guestATC.setupGuest(name, layout, request.installATC === true, request.log ?? (() => {})),
      );
    } catch (error) {
      const undone = await tryUndoPrepare(name, label, created, leased);

      if (created) {
        impIDs.delete(name);
      }

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
    impIDs.delete(name);
    guestATC.removeImageVersion(name);
  };

  const openHostReporter = (host: ImpHost, spec: HarnessSpec) => {
    invariant(guest !== null, 'the imp provider opens a reporter only after a readying');

    return openReporter({ port, guestDir: guest.directory, reconnectDelaysMs }, host, spec);
  };

  const broker = buildImpCredentialBroker(port, {
    impPrefix,
    getImpName: (hostKey) => getImpName(hostKey),
    createImp: async (hostKey) => {
      const name = getImpName(hostKey);

      const made = await port.createImp(buildCreateImpSpec(name, target));

      impIDs.set(name, made.id);

      return made;
    },
    readImp: async (hostName) => {
      const existing = await port.readImp(hostName);

      if (existing === null) {
        impIDs.delete(hostName);
      } else {
        impIDs.set(hostName, existing.id);
      }

      return existing;
    },
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

    readGuest: async (hostKey) => {
      try {
        return await readLayout();
      } catch (error) {
        throw toHostRefusal(error, getImpName(hostKey));
      }
    },

    impPrefix,

    credentials: { kind: 'broker', broker, rebindChangedAuth },

    ...(target.sessionEnv === undefined ? {} : { sessionEnv: target.sessionEnv }),

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

        const existing = await port.readImp(name);

        if (existing === null) {
          impIDs.delete(name);

          return false;
        }

        impIDs.set(name, existing.id);

        issuer = await port.readIssuer();

        return true;
      } catch {
        return false;
      }
    },

    findHostFact: (hostKey): HostFact => {
      const name = getImpName(hostKey);
      const id = impIDs.get(name);

      return {
        name,
        ...(id === undefined ? {} : { id }),
        ...(issuer === null ? {} : { issuer }),
      };
    },

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

      const reporter = spec.onRelay === undefined ? null : openHostReporter(host, spec);
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
      // The archive crosses the network, so it goes gzipped: the imp-base image ships gzip and
      // no faster decompressor.
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

    // The host service refuses to suspend while any lease is held, this daemon's own included,
    // so the daemon releases its lease before asking for the suspend.
    suspendHost: (hostKey, isIdle) =>
      withHostTurn(getImpName(hostKey), async () => {
        const host = getHost(hostKey);

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
