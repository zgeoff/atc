import { FLEET_CONTRACT, GATEWAY_PATHS } from '@atcx/contract';
import { traverseContractProcedures } from '@orpc/server';

// The path a request line or a security event records: `/rpc` and, when the request names a fleet
// procedure, that procedure's path. Any other path under `/rpc` is recorded as `/rpc`, so a
// client cannot write its own text into a log line.
export function buildRPCLogPath(pathname: string): string {
  const prefix = GATEWAY_PATHS.machine.rpc;

  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return pathname;
  }

  return isRPCProcedurePath(pathname) ? pathname : prefix;
}

// True for the path of one fleet procedure under `/rpc`.
export function isRPCProcedurePath(pathname: string): boolean {
  return findProcedurePaths().has(pathname);
}

let procedurePaths: ReadonlySet<string> | null = null;

function findProcedurePaths(): ReadonlySet<string> {
  if (procedurePaths === null) {
    const paths = new Set<string>();

    traverseContractProcedures({ router: FLEET_CONTRACT, path: [] }, (entry) => {
      paths.add(`${GATEWAY_PATHS.machine.rpc}/${entry.path.join('/')}`);
    });

    procedurePaths = paths;
  }

  return procedurePaths;
}
