export interface ImpPort {
  // impd's capability flags; an impd without them has neither.
  readonly readFeatures: () => Promise<ImpFeatures>;

  // The caller's own identity: its scope, the imps it may reach, and the
  // secrets it may grant.
  readonly readIdentity: () => Promise<ImpIdentity>;

  // Every secret impd holds, with its rules and never its value.
  readonly readSecrets: () => Promise<readonly ImpSecret[]>;

  // The names of the secrets granted to an imp.
  readonly readGrants: (name: string) => Promise<readonly string[]>;

  // impd's grant add is idempotent and returns no receipt, so nothing in the
  // result tells a new grant from an existing one or shows who added it.
  readonly createGrant: (name: string, secret: string) => Promise<void>;

  // Revokes a secret from an imp, and reports whether impd held the grant.
  readonly removeGrant: (name: string, secret: string) => Promise<boolean>;

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

  // Opens a connection as impd's single attacher; a start attaches when the
  // command already runs. gate runs as the request goes out, after any feature
  // check; false closes the connection unsent, and an earlier end never runs it.
  readonly openSession: (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ) => ImpSessionConnection;

  // Runs a command in the imp to its exit, without a terminal.
  readonly runCommand: (name: string, command: ImpCommand) => Promise<ImpCommandResult>;

  // Replaces a file the imp's processes see read-only, root included, and
  // resolves to its path inside the imp. `AGENT_OUTDATED` when the imp's
  // agent is from before read-only files.
  readonly writeReadOnlyFile: (name: string, path: string, content: string) => Promise<string>;

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

  // Tokens limited to some imps may grant a list of secrets to them.
  readonly grantableTokens: boolean;

  // A rebound or recreated secret drops its grants and leaves a token's
  // list of grantable secrets behind.
  readonly secretRebind: boolean;

  // A start may list what must be ready before the command runs, and impd
  // refuses the start without running it when one is not.
  readonly execRequire: boolean;

  // impd holds secrets of kind `oauth`, whose access token it renews from a
  // refresh token.
  readonly oauthSecrets: boolean;

  // impd writes files an imp's processes see read-only, root included.
  readonly readOnlyFiles: boolean;

  // A start may run its command without CAP_SYS_ADMIN, so root in it cannot
  // remount those read-only files writable.
  readonly execDropSysAdmin: boolean;
}

// A requirement impd readies before the command runs: for the broker, its CA
// installed in the imp and a grant behind its variables.
type ImpExecRequirement = 'broker';

type ImpScope = 'read' | 'exec' | 'manage';

export interface ImpIdentity {
  readonly kind: 'token' | 'ssh' | 'tailnet' | 'dashboard' | 'oauth';
  readonly name: string;
  readonly scope: ImpScope;

  // Imp name patterns with `*` for any run of characters; null reaches
  // every imp on the host.
  readonly imps: readonly string[] | null;

  // The secrets the caller may grant to the imps it reaches and revoke
  // from them.
  readonly grantable: readonly string[];
}

export interface ImpSecret {
  readonly name: string;
  readonly kind: 'anthropic' | 'custom' | 'github' | 'npm' | 'oauth';
  readonly rules: readonly ImpSecretRule[];

  // The imps holding a grant of the secret.
  readonly imps: readonly string[];

  // The sign-in state of an `oauth` secret; absent for any other kind.
  readonly oauth?: ImpOAuthState;
}

// pending lasts until a refresh first works, and needs_login follows the token
// endpoint refusing the refresh token for good. idClaims holds the last ID
// token's identifiers, never a credential.
interface ImpOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';
  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

// How impd adds a secret to requests for one host.
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
  // Whether this connection started the process rather than attaching.
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

  // Sends the process a signal by name, such as `SIGHUP`.
  readonly sendSignal: (signal: string) => void;

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
  readonly onData: (listener: (data: Uint8Array) => void) => void;
  readonly onClose: (listener: () => void) => void;

  // Runs once the guest has sent its last byte. impd keeps the relay open,
  // and counts it against the forward's relays, until the daemon closes it.
  readonly onEnd: (listener: () => void) => void;

  // Sends bytes to the guest's end of the connection, and settles once the
  // relay has room for more.
  readonly write: (data: Uint8Array) => Promise<void>;
  readonly close: () => void;
}

export interface ImpReverseForward {
  // Settles once impd listens on the guest path.
  readonly listening: Promise<void>;

  // Settles once the forward listens no more, with why. A forward never
  // listens again after it ends, so a guest connection after that reaches
  // nothing until a new forward listens on the path.
  readonly ended: Promise<ImpForwardEnd>;
  readonly stop: () => void;
}

// Why a reverse forward ended: its own stop, the imp going away (lost), its
// tunnel socket closing with a code, or impd refusing it.
export type ImpForwardEnd =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'closed'; readonly code: number; readonly reason: string }
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string };
