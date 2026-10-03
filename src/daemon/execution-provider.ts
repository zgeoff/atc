import type { DaemonError } from '../protocol/daemon-error';
import type { BrokerAuthHost } from './broker-auth-host';

/**
 * The host a session's harness runs on: it starts a process in a
 * pseudo-terminal and, as its capabilities declare, unpacks files into its
 * filesystem and runs commands there. The daemon starts every session
 * terminal through this interface, so a new host is a provider, not a
 * change to the session code. The daemon checks a capability before it
 * calls the operation behind it, and a request needing one the provider
 * lacks fails with `unsupported_operation`.
 */
export interface ExecutionProvider {
  // The provider kind a target's config selects, such as `local-pty`.
  readonly kind: string;
  readonly capabilities: ExecutionCapabilities;

  // Whether the host is a machine other than the daemon's own. A remote
  // harness's files, transcripts included, live on that machine, and its
  // environment holds only what atc sets for it.
  readonly remote: boolean;

  // Where a remote host keeps atc's files: the folder each session's own
  // files unpack under, and the atc binary inside the host, null when the
  // host has none. Absent on the daemon's own machine.
  readonly guest?: GuestLayout;

  // How a harness here can take its credential from impd's broker instead
  // of holding it. Absent on a host with no broker, which never starts a
  // session that needs one.
  readonly brokerAuth?: BrokerAuthHost;

  // Readies the host a harness is about to start on: a remote host is
  // created when missing, woken when asleep, and held awake while its
  // harnesses run. Rejects with the refusal before any harness starts.
  readonly prepareHost: (request: HostRequest) => Promise<void>;

  // Starts a process in a pseudo-terminal of the given size, on the host the
  // spec holds, which a prepare readied first.
  readonly spawnHarness: (spec: HarnessSpec) => HarnessHandle;

  // Unpacks a tar archive into a directory on a host, creating the directory
  // first. The daemon's own machine takes no host.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive: (archive: Uint8Array, dir: string, host?: string) => Promise<void>;

  // Runs a command to completion and returns what it printed.
  readonly runCommand: (spec: CommandSpec) => Promise<CommandResult>;

  // Puts a host to sleep with every harness on it kept inside, so a revive
  // finds each one as it was. Rejects with `host_leased` when another owner
  // keeps the host awake, and leaves the host as it was then. A sleep runs
  // after any readying of the host before it, and a readying waits for it.
  // isIdle makes it a sleep of an idle host only: it is checked when the
  // sleep starts and again just before the host sleeps, and a host that a
  // harness or a readying keeps busy stays awake with `host_unavailable`.
  readonly suspendHost: (host: string, isIdle?: () => boolean) => Promise<void>;

  // Deletes a host and everything on it, harnesses included. Nothing brings
  // a destroyed host back.
  readonly destroyHost: (host: string) => Promise<void>;

  // Stops the provider's own background work when the daemon stops, and
  // leaves every remote harness running for the next daemon to find.
  readonly dispose: () => void;
}

/**
 * The host a harness is about to start on, and the daemon that holds it:
 * a remote host is held per daemon, so two daemons never release each
 * other's hold.
 */
export interface HostRequest {
  readonly host: string;
  readonly daemonID: string;

  // Whether the harness about to start needs atc inside the host, which a
  // provider that ships its own binary installs when missing.
  readonly installATC?: boolean;

  // Whether the daemon has nothing running or starting on the host, which
  // the provider checks before it gives the host's lease back on its own.
  readonly isIdle?: () => boolean;
}

export interface GuestLayout {
  readonly dir: string;
  readonly atc: string | null;
}

/**
 * What a provider can do. The terminal capabilities split so a host that can
 * show output but not take input, or not resize, says so; `suspend` and
 * `destroy` cover the lifecycle of a host that outlives its process.
 */
export interface ExecutionCapabilities {
  // Start a harness in a pseudo-terminal.
  readonly spawn: boolean;

  // Stream a running harness's output to attached clients.
  readonly attach: boolean;

  // Write keystrokes to a running harness.
  readonly input: boolean;

  // Change a running harness's terminal size.
  readonly resize: boolean;

  // End a running harness.
  readonly kill: boolean;

  // Unpack an archive into the host's filesystem.
  readonly transfer: boolean;

  // Run a command on the host to completion.
  readonly run: boolean;

  // Run an agent turn without a terminal, through the agent's own runner.
  readonly headless: boolean;

  // Pause the host and resume it later with its state intact.
  readonly suspend: boolean;

  // Delete the host and everything on it.
  readonly destroy: boolean;
}

export type ExecutionCapability = keyof ExecutionCapabilities;

export interface HarnessSpec {
  // The atc session the harness belongs to, and the host it runs on: the
  // session's own id, or its parent's when the two share a host.
  readonly session: string;
  readonly host: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;

  // The variables atc sets for the harness. A provider for the daemon's
  // own machine adds the daemon's environment around them; a remote one
  // passes only these and its own.
  readonly env: Readonly<Record<string, string>>;

  // The variable names the harness goes without even when the daemon's
  // environment holds them, such as a workspace's credential; none of the
  // variables atc sets is withheld.
  readonly withheldEnv?: readonly string[];
  readonly cols: number;
  readonly rows: number;

  // Whether the harness must not start unless the host's credential broker
  // is ready: the host refuses the start and runs nothing otherwise, on
  // every start, a revive's included.
  readonly requireBroker?: boolean;

  // Admits each start or attach of a harness that requires the broker by
  // calling send, which hands the request to the host, or rejects with the
  // refusal that ends the harness instead, sending nothing. send gets the
  // admission's ticket.
  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;

  // Takes each connection a process of the harness opens to the daemon. A
  // remote provider relays them from a socket inside the host that serves
  // this harness alone, and points the harness's ATC_SOCKET at it.
  readonly onRelay?: (relay: HarnessRelay) => void;
}

/**
 * One connection from a process inside a harness's host to the daemon, in
 * lines: each line the process writes arrives whole, and each line the
 * daemon writes reaches the process in order.
 */
/**
 * One admitted request of a harness behind the broker. check runs just
 * before the request goes out and returns the refusal that stops it
 * unsent, or null to let it go; release gives the admission up once its
 * connection ends without the request going out. Each runs at most once
 * to any effect.
 */
export interface LaunchTicket {
  readonly check: () => DaemonError | null;
  readonly release: () => void;
}

export interface HarnessRelay {
  readonly onLine: (listener: (line: string) => void) => void;
  readonly onClose: (listener: () => void) => void;

  // Settles once the relay has room for more.
  readonly writeLine: (line: string) => Promise<void>;
  readonly close: () => void;
}

/**
 * A running harness. Output and exit arrive through listeners, each
 * subscription detachable on its own.
 */
export interface HarnessHandle {
  readonly onData: (listener: (data: string) => void) => HarnessSubscription;
  readonly onExit: (listener: (exit: HarnessExit) => void) => HarnessSubscription;

  // Follows a remote harness's connection: lost and being restored, or
  // restored. A harness on the daemon's own machine has no connection.
  readonly onAttachment?: (
    listener: (attachment: HarnessAttachment) => void,
  ) => HarnessSubscription;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;

  // Sends the harness's process the signal that ends it, and returns without
  // waiting for it to exit.
  readonly kill: () => void;

  // Ends the harness's process with a signal it cannot catch or ignore, on
  // a provider that can send one; absent on a provider that cannot.
  readonly killForced?: () => void;

  // Resolves once the harness's process has started, or a running one was
  // attached, and rejects with the refusal when the host ends the harness
  // or the daemon lets go of it first. Absent on a provider whose harness
  // starts at once.
  readonly waitForStart?: () => Promise<void>;

  // Resolves true once the harness's process has exited, and false when the
  // wait runs out first or the harness stops being followed without an
  // exit, such as a host that went to sleep with the process inside.
  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;

  // Stops following the harness and leaves its process running, for a host
  // that keeps it after the daemon lets go; on a host that cannot keep it,
  // the process ends as a kill ends it. No listener fires after a detach.
  readonly detach: () => void;
}

export type HarnessAttachment = 'attached' | 'reattaching';

interface HarnessSubscription {
  readonly dispose: () => void;
}

export interface HarnessExit {
  readonly exitCode: number;

  // Why the harness stopped: its process exited, its host went to sleep
  // with the process inside, or the host lost it without an exit, such as
  // a cold boot. Absent is an exit.
  readonly reason?: 'exited' | 'suspended' | 'ended';

  // What ended it, for a reason other than an exit.
  readonly detail?: string;
}

export interface CommandSpec {
  readonly argv: readonly string[];
  readonly cwd: string;

  // The host the command runs on; the daemon's own machine takes none.
  readonly host?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
