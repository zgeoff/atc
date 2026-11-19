import { GATEWAY_PATHS } from '@atcx/contract';

const MCP_PATHS: ReadonlySet<string> = new Set([
  GATEWAY_PATHS.machine.mcp,
  GATEWAY_PATHS.machine.root,
]);

export function isLabelledRequest(
  request: Request,
  hosts: ReadonlySet<string>,
  origins: ReadonlySet<string>,
): boolean {
  const requestOrigin = request.headers.get('origin');

  return (
    request.method === 'POST' &&
    MCP_PATHS.has(new URL(request.url).pathname) &&
    hosts.has(request.headers.get('host') ?? '') &&
    (requestOrigin === null || origins.has(requestOrigin))
  );
}
