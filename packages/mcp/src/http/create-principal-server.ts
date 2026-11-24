import { createFleetClient } from '@atc/fleet-api';
import type { McpServer } from '@modelcontextprotocol/server';
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { registerEventMethods } from '../events/register-event-methods';
import { createMCPServer } from '../tools/create-mcp-server';

export function createPrincipalServer(ctx: HTTPServerContext, access: VerifiedAccess): McpServer {
  const principal = { id: access.clientID, name: access.clientName };

  const server = createMCPServer({
    caller: ctx.caller,
    router: ctx.router,
    principal,
    build: ctx.build,
    toolContext: { callerSessionID: null },
    scopes: access.scopes,
  });

  registerEventMethods(server, {
    db: ctx.events,
    client: createFleetClient(ctx.router, { principal, scopes: access.scopes }),
    clientID: access.clientID,
    send: ctx.sendWebhook,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  });

  return server;
}
