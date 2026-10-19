import type { StepTimer } from '@atc/core';
import type { DaemonError } from '@atc/protocol/wire';
import type { CredentialBroker } from './credential-broker';

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
  readonly brokerAuth?: CredentialBroker;

  // Whether a launch behind the broker on a host whose agent's auth
  // selection changed since the host was bound moves the host's binding to
  // the current selection instead of refusing. Absent refuses.
  readonly rebindChangedAuth?: boolean;

  // Whether the host fetches a workspace's repository over its own network,
  // so the workspace never crosses the daemon's link. Absent clones on the
  // daemon's side and transfers the result.
  readonly cloneOnTarget?: boolean;

  // Whether the host has no git identity of its own, so a checkout there
  // takes the daemon host's. Absent leaves the host's own git config.
  readonly hostGitIdentity?: boolean;

  // Whether the provider can trust a verified clone on the host for an agent
  // that signs in through the broker. Absent refuses that trust.
  readonly guestWorkspaceTrust?: boolean;

  // Creates a missing remote host, wakes a sleeping one, and holds it awake while its harnesses
  // run. A failure after it created something it cannot take back rejects with an effect-remains
  // error instead of the refusal, so a retry under the same key never creates a second host.
  readonly prepareHost: (request: HostRequest) => Promise<void>;

  // Checks that an existing host is reachable with this provider's current
  // credentials. Creates nothing and takes no lease. Absent when the
  // provider cannot check an existing host.
  readonly checkExistingHost?: (host: string) => Promise<boolean>;

  // Starts a process in a pseudo-terminal of the given size, on the host the
  // spec holds, which a prepare readied first.
  readonly spawnHarness: (spec: HarnessSpec) => HarnessHandle;

  // Unpacks a tar archive into a directory on a host, creating the directory
  // first. The daemon's own machine takes no host.
  readonly transferArchive: (archive: Uint8Array, dir: string, host?: string) => Promise<void>;

  // Runs a command to completion and returns what it printed.
  readonly runCommand: (spec: CommandSpec) => Promise<CommandResult>;

  // Replaces in one step a file the host's processes see read-only, root included, and resolves
  // to its path on the host, or null on a host with no such place. The path is relative, its
  // segments of letters, digits, `.`, `_`, and `-`, none starting with a dot.
  readonly writeReadOnlyFile?: (
    host: string,
    path: string,
    content: string,
  ) => Promise<string | null>;

  // Sleeps a host with its harnesses inside, after any readying before it; a later readying waits.
  // Rejects with `host_leased`, leaving the host as it was, when another owner keeps it awake.
  // isIdle, checked at start and just before sleep, keeps a busy host awake (`host_unavailable`).
  readonly suspendHost: (host: string, isIdle?: () => boolean) => Promise<void>;

  // Deletes a host and everything on it, harnesses included. Nothing brings
  // a destroyed host back.
  readonly destroyHost: (host: string) => Promise<void>;

  // Stops the provider's own background work when the daemon stops, and
  // leaves every remote harness running for the next daemon to find. The
  // daemon waits for a returned promise before it exits.
  readonly dispose: () => void | Promise<void>;
}

export interface HostRequest {
  readonly host: string;

  // a remote host is held per daemon, so two daemons never release each
  // other's hold.
  readonly daemonID: string;

  // Whether the harness about to start needs atc inside the host, which a
  // provider that ships its own binary installs when missing.
  readonly installATC?: boolean;

  // Where the provider reports how it readied the host, one line at a
  // time, such as which atc the host's hooks run.
  readonly log?: (line: string) => void;

  // Whether the daemon has nothing running or starting on the host, which
  // the provider checks before it gives the host's lease back on its own.
  readonly isIdle?: () => boolean;

  // Times each step of the readying under its name, for the launch that
  // asked for it.
  readonly timer?: StepTimer;
}

export interface GuestLayout {
  readonly dir: string;
  readonly atc: string | null;
}

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

  // A relative directory on a remote host lies under the home of the user
  // the harness runs there as, as it does for a command.
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
  // calling send with the admission's ticket, which hands the request to the
  // host, or rejects with the refusal that ends the harness, sending nothing.
  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;

  // Takes each connection a process of the harness opens to the daemon. A
  // remote provider relays them from a socket inside the host that serves
  // this harness alone, and points the harness's reporter socket at it.
  readonly onRelay?: (relay: HarnessRelay) => void;
}

// each of check and release runs at most once to any effect.
export interface LaunchTicket {
  // runs just before the request goes out; the refusal stops it unsent.
  readonly check: () => DaemonError | null;

  // gives the admission up once its connection ends without the request
  // going out.
  readonly release: () => void;
}

// each line arrives whole and in order, both ways. A host can hold the connection open after the
// process stops writing, until the daemon closes it too, and can cap how many it holds open.
export interface HarnessRelay {
  readonly onLine: (listener: (line: string) => void) => void;
  readonly onClose: (listener: () => void) => void;

  // Runs once the process has written its last line, after every line
  // listener saw that line; the daemon can still write.
  readonly onEnd: (listener: () => void) => void;

  // Settles once the relay has room for more.
  readonly writeLine: (line: string) => Promise<void>;
  readonly close: () => void;
}

export interface HarnessHandle {
  // The pid of the harness's process on the daemon's own machine, which the
  // daemon matches a local client's process against; absent on a provider
  // whose harness runs on another host.
  readonly pid?: number;

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

  // Resolves once the harness's process has started or a running one was attached, and rejects
  // with the refusal when the host ends the harness or the daemon lets go of it first. Absent on a
  // provider whose harness starts at once.
  readonly waitForStart?: () => Promise<HarnessStart>;

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

export interface HarnessStart {
  // false when the start attached to a process its host still ran, which
  // keeps the settings it launched with.
  readonly created: boolean;
}

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

  // A relative directory on a remote host lies under the home of the user
  // the command runs there as, as it does for a harness.
  readonly cwd: string;

  // The host the command runs on; the daemon's own machine takes none.
  readonly host?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
