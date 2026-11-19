import type { McpServer } from '@modelcontextprotocol/server';
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { registerEventMethods } from '../events/register-event-methods';
import { buildPrincipalCaller } from '../tools/build-principal-caller';
import { createMCPServer } from '../tools/create-mcp-server';

export function createPrincipalServer(ctx: HTTPServerContext, access: VerifiedAccess): McpServer {
  const caller = buildPrincipalCaller(ctx.caller, { id: access.clientID, name: access.clientName });

  const server = createMCPServer({
    caller,
    build: ctx.build,
    toolContext: { callerSessionID: null },
    scopes: access.scopes,
  });

  registerEventMethods(server, {
    db: ctx.events,
    caller,
    clientID: access.clientID,
    send: ctx.sendWebhook,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  });

  return server;
}
