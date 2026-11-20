import type { StepTimer } from '@atc/core';
import type { AtcError } from '@atcx/contract/light';
import type { HostCredentials } from '../credentials/host-credentials';

export interface ExecutionProvider {
  readonly kind: string;
  readonly capabilities: ExecutionCapabilities;

  readonly remote: boolean;

  readonly readGuest?: (host: string) => Promise<GuestLayout>;

  readonly credentials?: HostCredentials;

  readonly sessionEnv?: Readonly<Record<string, string>>;

  readonly cloneOnTarget?: boolean;

  readonly hostGitIdentity?: boolean;

  readonly guestWorkspaceTrust?: boolean;

  readonly prepareHost: (request: HostRequest) => Promise<void>;

  readonly checkExistingHost?: (host: string) => Promise<boolean>;

  readonly findHostFact?: (host: string) => HostFact | null;

  readonly readHarnessFates?: (
    host: string,
    sessions: readonly string[],
  ) => Promise<ReadonlyMap<string, HarnessFate>>;

  readonly spawnHarness: (spec: HarnessSpec) => HarnessHandle;

  readonly transferArchive: (
    archive: Uint8Array,
    directory: string,
    host?: string,
  ) => Promise<void>;

  readonly runCommand: (spec: CommandSpec) => Promise<CommandResult>;

  readonly writeReadOnlyFile?: (
    host: string,
    path: string,
    content: string,
  ) => Promise<string | null>;

  readonly suspendHost: (host: string, isIdle?: () => boolean) => Promise<void>;

  readonly destroyHost: (host: string) => Promise<void>;

  readonly dispose: () => void | Promise<void>;
}

export interface HostRequest {
  readonly host: string;

  readonly daemonID: string;

  readonly installATC?: boolean;

  readonly log?: (line: string) => void;

  readonly isIdle?: () => boolean;

  readonly timer?: StepTimer;
}

export interface HostFact {
  readonly name: string;

  readonly id?: string;

  readonly issuer?: string;
}

export interface GuestLayout {
  readonly directory: string;
  readonly atc: string | null;

  readonly signIn: string | null;
}

export type HarnessFate = 'kept' | 'lost' | 'unknown';

export interface ExecutionCapabilities {
  readonly spawn: boolean;

  readonly attach: boolean;

  readonly input: boolean;

  readonly resize: boolean;

  readonly kill: boolean;

  readonly transfer: boolean;

  readonly run: boolean;

  readonly headless: boolean;

  readonly suspend: boolean;

  readonly destroy: boolean;

  readonly relay: boolean;
}

export type ExecutionCapability = keyof ExecutionCapabilities;

export interface HarnessSpec {
  readonly session: string;
  readonly host: string;
  readonly bin: string;
  readonly args: readonly string[];

  readonly cwd: string;

  readonly env: Readonly<Record<string, string>>;

  readonly withheldEnv?: readonly string[];
  readonly cols: number;
  readonly rows: number;

  readonly requireBroker?: boolean;

  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;

  readonly onRelay?: (relay: HarnessRelay) => void;
}

export interface LaunchTicket {
  readonly check: () => AtcError | null;

  readonly release: () => void;
}

export interface HarnessRelay {
  readonly onLine: (listener: (line: string) => void) => void;
  readonly onClose: (listener: () => void) => void;

  readonly onEnd: (listener: () => void) => void;

  readonly writeLine: (line: string) => Promise<void>;
  readonly close: () => void;
}

export interface HarnessHandle {
  readonly pid?: number;

  readonly onData: (listener: (data: string) => void) => HarnessSubscription;
  readonly onExit: (listener: (exit: HarnessExit) => void) => HarnessSubscription;

  readonly onAttachment?: (
    listener: (attachment: HarnessAttachment) => void,
  ) => HarnessSubscription;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;

  readonly kill: () => void;

  readonly killForced?: () => void;

  readonly waitForStart?: () => Promise<HarnessStart>;

  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;

  // Stops following the harness and leaves its process running, for a host that keeps it
  // after the daemon lets go. On a host that cannot, the process ends as when killed.
  // No listener fires afterward.
  readonly detach: () => void;
}

export type HarnessAttachment = 'attached' | 'reattaching';

export interface HarnessStart {
  // True when the provider started the harness, false when it attached to one the host
  // still ran for the session, which keeps its launch settings. A remote host that runs
  // none starts the argv it was given; a resume sets that to the agent's resume command.
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

  readonly detail?: string;
}

export interface CommandSpec {
  readonly argv: readonly string[];

  // A relative directory on a remote host lies under the home of the user
  // the command runs there as, as it does for a harness.
  readonly cwd: string;

  readonly host?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
