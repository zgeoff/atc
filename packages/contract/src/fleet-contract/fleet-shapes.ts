import type { z } from 'zod';

// What differs between the gateway's contract and one daemon's: the answers that carry session
// ids, the inputs that name a daemon or a parent, and the procedures only one of them has. Each
// field keeps its own type, so the contract built from it holds the exact schemas.
export interface FleetShapes<
  TDaemonInput extends z.ZodRawShape,
  TSpawnInput extends z.ZodRawShape,
  TEventsCursor extends z.ZodType,
  TSessionList extends z.ZodType,
  TSpawn extends z.ZodType,
  TSessionGet extends z.ZodType,
  TAgentsList extends z.ZodType,
  TEventsPage extends z.ZodType,
  TExtraProcedures extends object,
> {
  readonly daemonInput: TDaemonInput;
  readonly spawnInput: TSpawnInput;
  readonly eventsCursor: TEventsCursor;
  readonly sessionList: TSessionList;
  readonly spawn: TSpawn;
  readonly sessionGet: TSessionGet;
  readonly agentsList: TAgentsList;
  readonly eventsPage: TEventsPage;
  readonly extraProcedures: TExtraProcedures;
}
