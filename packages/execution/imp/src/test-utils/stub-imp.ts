import type { IPty } from 'bun-pty';
import type { ImpdExecOutcome } from '../impd/impd-procedure';
import type {
  ColdBoot,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpState,
  PreviousGeneration,
} from '../port/imp-port';

export interface StubImp {
  readonly id: string;
  readonly name: string;
  state: ImpState;
  bootId: string;
  coldBoots: ColdBoot[];
  readonly leases: Map<string, StubLease>;
  readonly sessions: Map<string, StubProcess>;
  readonly previous: Map<string, PreviousGeneration>;

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

  readonly argv: readonly string[];
  ring: Uint8Array;
  end: number;
  exited: { readonly code: number | null } | null;

  // Ended by a cold boot: its exit is never delivered.
  ended: boolean;
  connection: StubConnection | null;

  readonly requireBroker: boolean;
}

export interface StubConnection {
  readonly handlers: ImpSessionHandlers;
  sent: number;
  finished: boolean;
  process: StubProcess | null;
  readonly stop: (outcome: StubSessionOutcome) => void;

  readonly stopMalformed: (
    outcome: Extract<ImpSessionOutcome, { readonly kind: 'failed' }>,
  ) => void;
}

type StubSessionOutcome =
  | ImpdExecOutcome
  | Extract<ImpSessionOutcome, { readonly kind: 'local_error' }>;
