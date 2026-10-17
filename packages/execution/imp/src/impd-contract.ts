import type {
  ExecOutcome,
  ExecStarted,
  ImpClient,
  InvalidResumeData,
  InvalidStateData,
  NoSessionData,
  ORPCError,
} from '@impz/client';

// impd's RPC procedures as the client holds them, one namespace each,
// without the client's own helpers.
type ImpdRouter = {
  readonly [N in keyof ImpClient as ImpClient[N] extends (...args: never) => unknown
    ? never
    : N]: ImpClient[N];
};

/**
 * One RPC procedure of impd's published contract, by its dotted path, such
 * as `leases.acquire`.
 */
export type ImpdProcedure = {
  [N in keyof ImpdRouter & string]: `${N}.${keyof ImpdRouter[N] & string}`;
}[keyof ImpdRouter & string];

type ImpdCall<P extends ImpdProcedure> = P extends `${infer N extends keyof ImpdRouter}.${infer M}`
  ? M extends keyof ImpdRouter[N]
    ? ImpdRouter[N][M]
    : never
  : never;

type ImpdResult<P extends ImpdProcedure> =
  ImpdCall<P> extends (...args: never) => infer R ? R : never;

/**
 * What impd answers a procedure with, as the contract types it.
 */
export type ImpdOutput<P extends ImpdProcedure> = Awaited<ImpdResult<P>>;

// The errors the client types a procedure's call to reject with, for each
// procedure of a union in turn.
type ImpdError<P extends ImpdProcedure> = P extends unknown
  ? ImpdResult<P> extends { readonly __error?: { readonly type: infer E } }
    ? E
    : never
  : never;

/**
 * A refusal impd may answer a procedure with: one code of the procedure's
 * error map and the data the contract gives that code, the `BAD_REQUEST`
 * that oRPC answers an input its schema rejects with, or the
 * `INTERNAL_SERVER_ERROR` it answers a failure the map lacks with.
 */
export type ImpdRefusal<P extends ImpdProcedure> =
  | (Extract<ImpdError<P>, ORPCError<string, unknown>> extends infer E
      ? E extends ORPCError<infer C, infer D>
        ? ImpdRefusalOf<C, D>
        : never
      : never)
  | { readonly code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR'; readonly data?: undefined };

// One code with its data: none for a code the contract gives no data,
// optional for optional data, and required otherwise.
type ImpdRefusalOf<C, D> = unknown extends D
  ? { readonly code: C; readonly data?: undefined }
  : undefined extends D
    ? { readonly code: C; readonly data?: D }
    : { readonly code: C; readonly data: D };

/**
 * A refusal code impd may answer a procedure with and send no data.
 */
export type ImpdBareRefusalCode<P extends ImpdProcedure> =
  ImpdRefusal<P> extends infer R
    ? R extends { readonly code: infer C; readonly data?: infer D }
      ? undefined extends D
        ? C
        : never
      : never
    : never;

/**
 * Where an exec's data sits in the session's output, as impd starts it.
 */
export type ImpdSessionOutput = ExecStarted['output'];

/**
 * How impd ends an exec WebSocket, as the client reports it, without the
 * client's own local errors. A refusal that impd's exec protocol defines
 * data for carries that data.
 */
export type ImpdExecOutcome =
  | Exclude<ExecOutcome, { readonly kind: 'failed' | 'local_error' }>
  | ({ readonly kind: 'failed'; readonly message: string } & ImpdExecRefusal);

/**
 * A refusal of an exec start or attach: a code with the data impd's exec
 * protocol gives it, or a code of the contract's error map with its data.
 */
export type ImpdExecRefusal =
  | { readonly code: 'NO_SESSION'; readonly data: NoSessionData }
  | { readonly code: 'INVALID_RESUME'; readonly data: InvalidResumeData }
  | { readonly code: 'INVALID_STATE'; readonly data: InvalidStateData }
  | Exclude<ImpdRefusal<'exec.ticket'>, { readonly code: 'INVALID_STATE' | 'BAD_REQUEST' }>
  | { readonly code: null; readonly data?: null | undefined };
