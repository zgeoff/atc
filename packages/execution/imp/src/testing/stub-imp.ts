import type { IPty } from 'bun-pty';
import type {
  ColdBoot,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpState,
  PreviousGeneration,
} from '../imp-port';
import type { ImpdExecOutcome } from '../impd-contract';

export interface StubImp {
  readonly id: string;
  readonly name: string;
  state: ImpState;
  bootId: string;
  coldBoots: ColdBoot[];
  readonly leases: Map<string, StubLease>;
  readonly sessions: Map<string, StubProcess>;
  readonly previous: Map<string, PreviousGeneration>;

  // The secrets granted to the imp.
  readonly grants: Set<string>;
}

interface StubLease {
  readonly principal: string;
  readonly label: string;
  readonly until: number;
}

export interface StubProcess {
  readonly pty: IPty;
  readonly generation: string;

  // The command line the process started with.
  readonly argv: readonly string[];
  ring: Uint8Array;
  end: number;
  exited: { readonly code: number | null } | null;

  // Ended by a cold boot: its exit is never delivered.
  ended: boolean;
  connection: StubConnection | null;

  // Whether its start required the broker, which a start that requires it
  // and would join the process needs.
  readonly requireBroker: boolean;
}

export interface StubConnection {
  readonly handlers: ImpSessionHandlers;
  sent: number;
  finished: boolean;
  process: StubProcess | null;
  readonly stop: (outcome: StubSessionOutcome) => void;

  // Ends the connection with a refusal outside impd's contract.
  readonly stopMalformed: (
    outcome: Extract<ImpSessionOutcome, { readonly kind: 'failed' }>,
  ) => void;
}

// How a stub connection ends: as impd ends an exec, or with a local error
// when a handler on the daemon's side throws.
type StubSessionOutcome =
  | ImpdExecOutcome
  | Extract<ImpSessionOutcome, { readonly kind: 'local_error' }>;
