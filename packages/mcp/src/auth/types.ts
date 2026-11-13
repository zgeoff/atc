import type { Clock } from '@atc/core';
import type { GrantScope } from '@atcx/contract';
import type { Access, SecuritySink } from '@zgeoff/mcp-auth';
import type { Kysely } from 'kysely';
import type { EventDeliverer } from '../events/create-event-deliverer';
import type { EventSchema } from '../events/event-schema';
import type { WebhookSender } from '../events/types';
import type { ModernMCPHandler } from '../http/create-modern-mcp-handler';
import type { FleetCaller } from '../tools/types';
import type { ATCAuth } from './open-atc-auth';

export type { Requester, SecurityEvent } from '@zgeoff/mcp-auth';

// What a valid bearer token grants: the client it was issued to, and the
// scopes it holds.
export type VerifiedAccess = Access<GrantScope, null>;

// What the MCP route and the live terminal read: the daemon, the server's
// own identity, the authorization server, and the event subscriptions.
export interface HTTPServerContext {
  readonly caller: FleetCaller;
  readonly build: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;
  readonly auth: ATCAuth;

  // atc's own event tables, on a connection of their own.
  readonly events: Kysely<EventSchema>;

  // Receives each refused token as a security event.
  readonly security: SecuritySink;

  // The time the routes stamp and check expiries against.
  readonly clock: Clock;

  // Serves the requests of the stateless protocol revision.
  readonly modern: ModernMCPHandler;

  // Delivers each MCP Events subscription's events, and posts a subscribe's
  // verification challenge.
  readonly deliverer: EventDeliverer;
  readonly sendWebhook: WebhookSender;
}
