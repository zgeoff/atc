import type { DaemonEvent, DaemonProcedures, HelloResult } from '@atcx/contract';

export interface CallContext {
  // the principal one call acts as
  readonly as?: string | undefined;

  // the name that labels a message the call sends
  readonly asName?: string | undefined;
}

export type DaemonTarget =
  | { readonly path: string }
  | { readonly hostname: string; readonly port: number };

export interface DaemonHello {
  readonly client: string;
  readonly token?: string | undefined;
  readonly principal?: string | undefined;
  readonly viewer?: string | undefined;

  // the atc session the caller runs in; a SessionID is one
  readonly session?: string | undefined;
}

export interface DaemonConnectionOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;

  // sees each answer before its call resolves
  readonly onAnswer?:
    | ((method: string, answer: Readonly<Record<string, unknown>>) => void)
    | undefined;
}

interface EventsOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface DaemonConnection {
  readonly hello: HelloResult;

  // a call acts as the hello's principal unless its context names another principal in `as`
  readonly procedures: DaemonProcedures<CallContext>;

  // the same call by its method name, such as 'session.list', for callers that route by name
  readonly request: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    context?: CallContext,
  ) => Promise<unknown>;
  readonly events: (options?: EventsOptions) => AsyncIterable<DaemonEvent>;

  // settles once the socket ends, for any reason; never rejects
  readonly closed: Promise<void>;

  // ends the socket and rejects each pending call with connection_lost; a second call resolves at once
  readonly close: () => Promise<void>;
}
