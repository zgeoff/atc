export interface ImpPort {
  readonly verifyVersion: () => Promise<void>;

  // The folder inside each imp that impd declares for scratch files.
  // Rejects with `IMPD_OUTDATED` when impd declares none.
  readonly readGuestScratchDir: () => Promise<string>;

  // The identity issuer impd signs host tokens as, or null while impd's
  // identity is off. A fact of impd, shared by all its imps.
  readonly readIssuer: () => Promise<string | null>;

  readonly readIdentity: () => Promise<ImpIdentity>;

  // Every secret impd holds, with its rules and never its value.
  readonly readSecrets: () => Promise<readonly ImpSecret[]>;

  readonly readGrants: (name: string) => Promise<readonly string[]>;

  // impd's grant add is idempotent and returns no receipt, so nothing in the
  // result tells a new grant from an existing one or shows who added it.
  readonly createGrant: (name: string, secret: string) => Promise<void>;

  readonly removeGrant: (name: string, secret: string) => Promise<boolean>;

  readonly readImp: (name: string) => Promise<ImpView | null>;
  readonly createImp: (spec: ImpCreateSpec) => Promise<ImpView>;

  // Creates or extends the caller's lease under a label, booting or waking
  // the imp first. The label `hold` is refused.
  readonly acquireLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;

  // Extends the caller's unexpired lease; `LEASE_NOT_HELD` when it ended.
  readonly renewLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;

  readonly releaseLease: (name: string, label: string) => Promise<boolean>;

  // Puts the imp to sleep without force: `LEASED` while any lease holds it.
  readonly suspendImp: (name: string) => Promise<void>;
  readonly destroyImp: (name: string) => Promise<void>;

  // impd allows a single attacher per session, and a start request attaches to the command
  // instead of starting it again when the command already runs.
  readonly openSession: (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ) => ImpSessionConnection;

  // Runs a command in the imp to its exit, without a terminal.
  readonly runCommand: (name: string, command: ImpCommand) => Promise<ImpCommandResult>;

  // Replaces a file that the imp's processes, root included, see as read-only, and resolves
  // to its path inside the imp. `AGENT_OUTDATED` when the imp's agent lacks read-only files.
  readonly writeReadOnlyFile: (name: string, path: string, content: string) => Promise<string>;

  readonly openReverseForward: (
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ) => ImpReverseForward;
}

// A requirement impd readies before the command runs: for the broker, its CA
// installed in the imp and a grant behind its variables.
type ImpExecRequirement = 'broker';

type ImpScope = 'read' | 'exec' | 'manage';

export interface ImpIdentity {
  readonly kind: 'token' | 'ssh' | 'tailnet' | 'dashboard' | 'oauth';
  readonly name: string;
  readonly scope: ImpScope;

  readonly imps: readonly string[] | null;

  readonly grantable: readonly string[];
}

export interface ImpSecret {
  readonly name: string;
  readonly kind: 'anthropic' | 'custom' | 'github' | 'npm' | 'oauth' | 'static';
  readonly rules: readonly ImpSecretRule[];

  readonly imps: readonly string[];

  readonly oauth?: ImpOAuthState;
}

// The stored ID claims are the last ID token's identifiers, never a credential.
interface ImpOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';
  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

export interface ImpSecretRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'basic' | 'bearer' | 'raw';
  readonly user?: string;
}

export type ImpState = 'creating' | 'running' | 'sleeping' | 'stopped' | 'error';

export interface ImpView {
  // impd's id for this imp, which a new imp made under the same name never
  // shares.
  readonly id: string;
  readonly name: string;
  readonly state: ImpState;

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
  readonly maxMemoryMib?: number;
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

// An imp whose agent carries no offsets replays recent output on every
// connection.
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
      readonly previous?: PreviousGeneration | undefined;
      readonly resume?: ResumeResult | undefined;
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

      // impd refuses the start with `PRECONDITION_FAILED` and runs nothing
      // when any of these is not ready.
      readonly require?: readonly ImpExecRequirement[];

      // The command and all it starts run without CAP_SYS_ADMIN and
      // CAP_SYS_PTRACE.
      readonly dropSysAdmin?: boolean;
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

  readonly onOutput: (data: Uint8Array) => void;
}

export interface ImpSessionStarted {
  readonly created: boolean;
  readonly output: SessionOutput;
}

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
  | { readonly kind: 'bad_message'; readonly detail: string }

  // A handler on the daemon's side threw, and the client closed the socket.
  | { readonly kind: 'local_error'; readonly detail: string };

export interface ImpSessionConnection {
  readonly outcome: Promise<ImpSessionOutcome>;

  readonly write: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;

  readonly sendSignal: (signal: string) => void;

  // The process keeps running under its session name; only this connection ends.
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
  readonly onData: (listener: (data: Uint8Array) => void) => void;
  readonly onClose: (listener: () => void) => void;

  // Runs once the guest has sent its last byte. impd keeps the relay open,
  // and counts it against the forward's relays, until the daemon closes it.
  readonly onEnd: (listener: () => void) => void;

  readonly write: (data: Uint8Array) => Promise<void>;
  readonly close: () => void;
}

export interface ImpReverseForward {
  readonly listening: Promise<void>;

  // impd never resumes listening for an ended forward, so a guest connection after this settles
  // reaches nothing until a new forward listens on the path.
  readonly ended: Promise<ImpForwardEnd>;
  readonly stop: () => void;
}

export type ImpForwardEnd =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'closed'; readonly code: number; readonly reason: string }
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string };
