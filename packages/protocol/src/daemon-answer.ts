import type { z } from 'zod';
import type { DAEMON_CONTRACT } from './daemon-contract';
import type { RequestMethod } from './parse-request-params';

export type DaemonAnswer<M extends RequestMethod> =
  FindProcedure<typeof DAEMON_CONTRACT, M> extends {
    readonly '~orpc': { readonly outputSchema?: infer Output };
  }
    ? Output extends z.ZodType
      ? z.input<Output>
      : never
    : never;

// The procedure at a dotted request method's path in a contract router.
type FindProcedure<Router, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Router
    ? FindProcedure<Router[Head], Rest>
    : never
  : Path extends keyof Router
    ? Router[Path]
    : never;
