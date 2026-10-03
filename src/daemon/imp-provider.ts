import { DaemonError } from '../protocol/daemon-error';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
  HostRequest,
} from './execution-provider';
import { ImpHarness } from './imp-harness';
import type { ImpPort } from './imp-port';
import { ImpPortError } from './imp-port-error';

/**
 * The options an `imp` target takes beside its provider: the image a new
 * imp boots and the memory it gets. Neither holds a credential.
 */
export interface ImpTargetOptions {
  readonly image?: string;
  readonly memoryMib?: number;
}

interface ImpProviderOptions {
  // How long each lease the daemon takes lasts before a renewal, in seconds.
  readonly leaseSeconds?: number;

  // The wait before each reconnect to a harness whose connection ended
  // without an exit, in milliseconds.
  readonly reconnectDelaysMs?: readonly number[];
}

// impd takes a lease of 10 to 3600 seconds; the daemon renews at a third of it.
const LEASE_SECONDS = 600;

// About 15 seconds of reconnects before a harness counts as ended.
const RECONNECT_DELAYS_MS: readonly number[] = [250, 1000, 2000, 4000, 8000];

// The PATH a guest harness runs with: the guest's standard one, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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

  private readonly port: ImpPort;

  private readonly target: ImpTargetOptions;

  private readonly leaseSeconds: number;

  private readonly reconnectDelaysMs: readonly number[];

  private readonly hosts = new Map<string, ImpHost>();

  // Whether impd carries output offsets, once a prepare has read its
  // features; an impd without the flag carries none.
  private offsets = false;

  // The lease label of the daemon this provider serves, once a prepare
  // names it.
  private label: string | null = null;

  constructor(port: ImpPort, target: ImpTargetOptions, options: ImpProviderOptions = {}) {
    this.port = port;
    this.target = target;
    this.leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  }

  // Creates the host's imp when impd holds none, then takes the daemon's
  // lease, which boots or wakes the imp.
  readonly prepareHost = async (request: HostRequest): Promise<void> => {
    const name = buildImpName(request.host);
    const label = `atc-${request.daemonID}`;

    this.label = label;

    try {
      const features = await this.port.readFeatures();

      this.offsets = features.sessionOffsets;

      const existing = await this.port.readImp(name);

      if (existing === null) {
        await this.port.createImp({
          name,
          ...(this.target.image === undefined ? {} : { image: this.target.image }),
          ...(this.target.memoryMib === undefined ? {} : { memoryMib: this.target.memoryMib }),
        });
      }

      await this.port.acquireLease(name, label, this.leaseSeconds);
    } catch (error) {
      throw toHostRefusal(error, name);
    }

    const host = this.hosts.get(request.host) ?? {
      name,
      harnesses: 0,
      renewTimer: null,
      suspending: false,
    };

    host.suspending = false;

    this.hosts.set(request.host, host);
    this.startRenewal(host, label);
  };

  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle => {
    const host = this.hosts.get(spec.host) ?? {
      name: buildImpName(spec.host),
      harnesses: 0,
      renewTimer: null,
      suspending: false,
    };

    this.hosts.set(spec.host, host);

    host.harnesses += 1;

    return new ImpHarness(
      this.port,
      {
        kind: 'start',
        name: host.name,
        session: buildImpSessionName(spec.session),
        argv: [spec.bin, ...spec.args],
        env: buildGuestEnv(spec.env),
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
      },
      {
        offsets: this.offsets,
        reconnectDelaysMs: this.reconnectDelaysMs,
        isSuspending: () => host.suspending,
        onDone: () => {
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
    const result = await this.runOnHost(host, {
      argv: ['sh', '-c', 'mkdir -p "$1" && tar -x -f - -C "$1"', 'sh', dir],
      stdin: archive,
    });

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
  readonly suspendHost = async (hostKey: string): Promise<void> => {
    const host = this.hosts.get(hostKey) ?? {
      name: buildImpName(hostKey),
      harnesses: 0,
      renewTimer: null,
      suspending: false,
    };

    this.hosts.set(hostKey, host);
    this.stopRenewal(host);

    host.suspending = true;

    try {
      if (this.label !== null) {
        await this.port.releaseLease(host.name, this.label);
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
  };

  // A destroy ends every lease on the imp with it.
  readonly destroyHost = async (hostKey: string): Promise<void> => {
    const host = this.hosts.get(hostKey);
    const name = buildImpName(hostKey);

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
  };

  readonly dispose = (): void => {
    for (const host of this.hosts.values()) {
      this.stopRenewal(host);
    }
  };

  private async runOnHost(
    hostKey: string | undefined,

    // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
    command: Readonly<{ argv: readonly string[]; cwd?: string; stdin?: Uint8Array }>,
  ) {
    if (hostKey === undefined) {
      throw new Error('the imp provider runs a command only on a session host');
    }

    try {
      return await this.port.runCommand(buildImpName(hostKey), command);
    } catch (error) {
      throw toHostRefusal(error, buildImpName(hostKey));
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
        if (host.harnesses === 0) {
          void this.tryReleaseLease(host);

          return;
        }

        void this.tryRenewLease(host, label);
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

  private async tryReleaseLease(host: ImpHost): Promise<boolean> {
    this.stopRenewal(host);

    if (this.label === null) {
      return false;
    }

    try {
      return await this.port.releaseLease(host.name, this.label);
    } catch {
      return false;
    }
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
}

/**
 * The imp a host key runs on: `atc-` and the first 20 letters and digits of
 * the key, which is the atc session id of the session that owns the host.
 */
function buildImpName(hostKey: string): string {
  return `atc-${hostKey
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 20)}`;
}

function buildImpSessionName(sessionID: string): string {
  return `atc-${sessionID
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 32)}`;
}

// A guest harness gets the variables atc sets for it and the guest's own
// terminal, locale, and PATH, never the daemon's environment. The daemon's
// reporter socket path means nothing inside the imp.
function buildGuestEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const own = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'ATC_SOCKET'));

  return { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: GUEST_PATH, ...own };
}

function buildLeasedRefusal(name: string, data: unknown): DaemonError {
  const record = typeof data === 'object' && data !== null ? data : {};
  const leases = 'leases' in record && Array.isArray(record.leases) ? record.leases : [];

  const otherCount =
    'otherCount' in record && typeof record.otherCount === 'number' ? record.otherCount : 0;

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
