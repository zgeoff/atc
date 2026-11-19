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
  readonly [
    N in keyof ImpClient as ImpClient[N] extends (...args: never) => unknown ? never : N
  ]: ImpClient[N];
};

export type ImpdProcedure = {
  [N in Extract<keyof ImpdRouter, string>]: `${N}.${Extract<keyof ImpdRouter[N], string>}`;
}[Extract<keyof ImpdRouter, string>];

type ImpdCall<P extends ImpdProcedure> = P extends `${infer N extends keyof ImpdRouter}.${infer M}`
  ? M extends keyof ImpdRouter[N]
    ? ImpdRouter[N][M]
    : never
  : never;

type ImpdResult<P extends ImpdProcedure> =
  ImpdCall<P> extends (...args: never) => infer R ? R : never;

export type ImpdOutput<P extends ImpdProcedure> = Awaited<ImpdResult<P>>;

// The errors the client types a procedure's call to reject with, for each
// procedure of a union in turn.
type ImpdError<P extends ImpdProcedure> = P extends unknown
  ? ImpdResult<P> extends { readonly __error?: { readonly type: infer E } }
    ? E
    : never
  : never;

// Beside the procedure's error map, oRPC answers an input its schema rejects
// with BAD_REQUEST and a failure the map lacks with INTERNAL_SERVER_ERROR.
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

export type ImpdBareRefusalCode<P extends ImpdProcedure> =
  ImpdRefusal<P> extends infer R
    ? R extends { readonly code: infer C; readonly data?: infer D }
      ? undefined extends D
        ? C
        : never
      : never
    : never;

export type ImpdSessionOutput = ExecStarted['output'];

export type ImpdExecOutcome =
  | Exclude<ExecOutcome, { readonly kind: 'failed' | 'local_error' }>
  | ({ readonly kind: 'failed'; readonly message: string } & ImpdExecRefusal);

export type ImpdExecRefusal =
  | { readonly code: 'NO_SESSION'; readonly data: NoSessionData }
  | { readonly code: 'INVALID_RESUME'; readonly data: InvalidResumeData }
  | { readonly code: 'INVALID_STATE'; readonly data: InvalidStateData }
  | Exclude<ImpdRefusal<'exec.ticket'>, { readonly code: 'INVALID_STATE' | 'BAD_REQUEST' }>
  | { readonly code: null; readonly data?: null | undefined };
