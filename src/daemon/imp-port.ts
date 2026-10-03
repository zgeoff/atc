/**
 * What the imp provider needs from impd, the imp host daemon, in atc's own
 * terms. The real binding wraps `@zgeoff/imp-client`, and the test fixture
 * runs imps as local pseudo-terminals, so nothing outside the imp modules
 * depends on the client library. Every call that impd refuses rejects with
 * an `ImpPortError` carrying impd's code and data.
 */
export interface ImpPort {
  // impd's capability flags; an impd without them has neither.
  readonly readFeatures: () => Promise<ImpFeatures>;

  // The imp under a name, or null when impd holds none.
  readonly readImp: (name: string) => Promise<ImpView | null>;
  readonly createImp: (spec: ImpCreateSpec) => Promise<ImpView>;

  // Creates or extends the caller's lease under a label, booting or waking
  // the imp first. The label `hold` is refused.
  readonly acquireLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;

  // Extends the caller's unexpired lease; `LEASE_NOT_HELD` when it ended.
  readonly renewLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;

  // Ends the caller's lease, and reports whether there was one.
  readonly releaseLease: (name: string, label: string) => Promise<boolean>;

  // Puts the imp to sleep without force: `LEASED` while any lease holds it.
  readonly suspendImp: (name: string) => Promise<void>;
  readonly destroyImp: (name: string) => Promise<void>;

  // Opens one connection to a session's terminal, as impd's single
  // attacher: a start runs the command under the session name, or attaches
  // when it already runs; an attach only attaches.
  readonly openSession: (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
  ) => ImpSessionConnection;

  // Runs a command in the imp to its exit, without a terminal.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
  readonly runCommand: (name: string, command: ImpCommand) => Promise<ImpCommandResult>;

  // Listens on a unix socket path inside the imp and hands each connection
  // the guest opens there to the daemon.
  readonly openReverseForward: (
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ) => ImpReverseForward;
}

export interface ImpFeatures {
  readonly sessionOffsets: boolean;
  readonly leases: boolean;
}

export type ImpState = 'creating' | 'running' | 'sleeping' | 'stopped' | 'error';

export interface ImpView {
  readonly name: string;
  readonly state: ImpState;

  // The caller's own leases in full, and a count of everyone else's.
  readonly leases: readonly ImpLease[];
  readonly otherLeaseCount: number;
}

export interface ImpLease {
  readonly name: string;
  readonly owner: { readonly principal: string; readonly display: string; readonly label: string };

  // Epoch ms; null holds with no end.
  readonly until: number | null;
}

export interface ImpCreateSpec {
  readonly name: string;
  readonly image?: string;
  readonly memoryMib?: number;
}

export type ColdBootCause =
  | 'start'
  | 'wake_fallback'
  | 'watchdog'
  | 'restore'
  | 'recovery'
  | 'unknown';

export interface ColdBoot {
  readonly bootId: string;
  readonly cause: ColdBootCause;
  readonly at: string;
}

// The last generation that ran under a session name in this boot, final
// once written.
export interface PreviousGeneration {
  readonly executionGeneration: string;
  readonly end: number;
  readonly exitCode: number | null;
}

interface ResumeFrom {
  readonly executionGeneration: string;
  readonly offset: number;
}

export type ResumeResult =
  | { readonly kind: 'exact' }
  | { readonly kind: 'gap'; readonly from: number; readonly to: number }
  | {
      readonly kind: 'generation_changed';
      readonly executionGeneration: string;
      readonly firstOffset: number;
    };

/**
 * Where a connection's data sits in the session's output. `none` is an imp
 * whose agent carries no offsets, which replays recent output on every
 * connection.
 */
type SessionOutput =
  | { readonly continuity: 'none' }
  | {
      readonly continuity: 'offsets';
      readonly bootId: string;
      readonly executionGeneration: string;
      readonly bufferStart: number;
      readonly end: number;
      readonly offset: number;
      readonly prelude: number;
      readonly coldBoots: readonly ColdBoot[];
      readonly previous?: PreviousGeneration;
      readonly resume?: ResumeResult;
    };

export type ImpSessionRequest =
  | {
      readonly kind: 'start';
      readonly name: string;
      readonly session: string;
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly resumeFrom?: ResumeFrom;
    }
  | {
      readonly kind: 'attach';
      readonly name: string;
      readonly session: string;
      readonly cols: number;
      readonly rows: number;
      readonly resumeFrom?: ResumeFrom;

      // false fails with `INVALID_STATE` instead of booting or waking the imp.
      readonly wake: boolean;
    };

export interface ImpSessionHandlers {
  readonly onStarted: (started: ImpSessionStarted) => void;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- output bytes have no readonly form
  readonly onOutput: (data: Uint8Array) => void;
}

export interface ImpSessionStarted {
  // Whether this connection started the process rather than attaching.
  readonly created: boolean;
  readonly output: SessionOutput;
}

/**
 * How a connection ended: the process exited, impd refused or failed the
 * request, impd detached the connection while the process ran on, or the
 * socket closed, with its close code once it had opened.
 */
export type ImpSessionOutcome =
  | {
      readonly kind: 'exit';
      readonly code: number | null;
      readonly signal: string | null;
      readonly offset?: number;
    }
  | {
      readonly kind: 'failed';
      readonly code: string | null;
      readonly message: string;
      readonly data?: unknown;
    }
  | {
      readonly kind: 'detached';
      readonly reason: 'taken_over' | 'slow' | 'lost';
      readonly offset?: number;
    }
  | { readonly kind: 'closed'; readonly reason: string; readonly closeCode?: number }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'bad_message'; readonly detail: string };

export interface ImpSessionConnection {
  readonly outcome: Promise<ImpSessionOutcome>;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- input bytes have no readonly form
  readonly write: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;

  // Closes the connection; the process runs on under its session name.
  readonly close: () => void;
}

export interface ImpCommand {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
}

export interface ImpCommandResult {
  readonly code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ImpRelayConnection {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
  readonly onData: (listener: (data: Uint8Array) => void) => void;
  readonly onClose: (listener: () => void) => void;
  readonly close: () => void;
}

export interface ImpReverseForward {
  // Settles once impd listens on the guest path.
  readonly listening: Promise<void>;
  readonly stop: () => void;
}
