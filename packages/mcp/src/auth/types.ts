import type { GrantScope } from '@atcx/contract';
import type { Access, SecuritySink } from '@zgeoff/mcp-auth';
import type { Clock } from '@zgeoff/std';
import type { Kysely } from 'kysely';
import type { EventDeliverer } from '../events/create-event-deliverer';
import type { EventSchema } from '../events/event-schema';
import type { WebhookSender } from '../events/types';
import type { ModernMCPHandler } from '../http/create-modern-mcp-handler';
import type { FleetCaller } from '../tools/types';
import type { ATCAuth } from './open-atc-auth';

export type { Requester, SecurityEvent } from '@zgeoff/mcp-auth';

export type VerifiedAccess = Access<GrantScope, null>;

export interface HTTPServerContext {
  readonly caller: FleetCaller;
  readonly build: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;
  readonly auth: ATCAuth;

  // atc's own event tables, on a connection of their own.
  readonly events: Kysely<EventSchema>;

  readonly security: SecuritySink;

  readonly clock: Pick<Clock, 'now' | 'schedule'>;

  readonly modern: ModernMCPHandler;

  readonly deliverer: EventDeliverer;
  readonly sendWebhook: WebhookSender;
}
