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

  // Starts a process in a pseudo-terminal of the given size.
  readonly spawnHarness: (spec: HarnessSpec) => HarnessHandle;

  // Unpacks a tar archive into a directory, creating the directory first.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive: (archive: Uint8Array, dir: string) => Promise<void>;

  // Runs a command to completion and returns what it printed.
  readonly runCommand: (spec: CommandSpec) => Promise<CommandResult>;
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

  // Pause the host and resume it later with its state intact.
  readonly suspend: boolean;

  // Delete the host and everything on it.
  readonly destroy: boolean;
}

export type ExecutionCapability = keyof ExecutionCapabilities;

export interface HarnessSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/**
 * A running harness. Output and exit arrive through listeners, each
 * subscription detachable on its own.
 */
export interface HarnessHandle {
  readonly onData: (listener: (data: string) => void) => HarnessSubscription;
  readonly onExit: (listener: (exit: HarnessExit) => void) => HarnessSubscription;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: () => void;
}

interface HarnessSubscription {
  readonly dispose: () => void;
}

interface HarnessExit {
  readonly exitCode: number;
}

export interface CommandSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
