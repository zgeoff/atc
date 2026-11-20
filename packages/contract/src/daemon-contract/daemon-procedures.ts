import type { ContractRouterClient } from '@orpc/contract';
import type { DAEMON_CONTRACT } from './daemon-contract';

// Every daemon procedure as a client calls it. A caller that names its own call context gets the
// context type in each procedure's options.
// oxlint-disable-next-line typescript/no-explicit-any -- oRPC's own bound for a client context is a record of any
export type DaemonProcedures<TContext extends Record<PropertyKey, any> = Record<string, never>> =
  ContractRouterClient<typeof DAEMON_CONTRACT, TContext>;
