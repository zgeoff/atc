import { GATEWAY_PATHS } from '@atcx/contract';
import { normalizeClientName } from './normalize-client-name';
import type { SecurityEvent } from './types';

export interface SuppressedSecurityEvent {
  readonly kind: 'suppressed';
  readonly reason: SecurityEvent['kind'];
  readonly count: number;
}

// The paths an event may hold as its route.
const ROUTES: ReadonlySet<string> = new Set(
  Object.values(GATEWAY_PATHS).flatMap((group) => Object.values(group)),
);

export function formatSecurityEvent(
  event: SecurityEvent | SuppressedSecurityEvent,
  at: number,
): string {
  const head = { version: 1, ts: new Date(at).toISOString(), kind: event.kind };

  if (event.kind === 'suppressed') {
    return `atc security ${JSON.stringify({ ...head, reason: event.reason, count: event.count })}`;
  }

  const requester = event.requester;

  const fields = {
    ...head,
    outcome: event.outcome,
    ...('reason' in event && event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.kind === 'owner_auth'
      ? { method: event.path === GATEWAY_PATHS.browser.enroll ? 'enrollment_token' : 'passkey' }
      : {}),
    route: ROUTES.has(event.path) ? event.path : 'other',
    ...(event.client === undefined
      ? {}
      : {
          client: {
            id: toEventText(event.client.id, 64),
            name: toEventText(event.client.name, 100),
          },
        }),
    ...(event.redirectHost === undefined
      ? {}
      : { redirectHost: toEventText(event.redirectHost, 255) }),
    ...(event.correlationID === undefined ? {} : { correlationID: event.correlationID }),
    ...(requester.socketAddress === null
      ? {}
      : { peer: { address: toEventText(requester.socketAddress, 45), provenance: 'socket' } }),
    ...(requester.connectingIP === null
      ? {}
      : {
          forwarded: {
            address: toEventText(requester.connectingIP.address, 45),
            header: 'cf-connecting-ip',
            provenance: requester.connectingIP.provenance,
          },
        }),
    ...(requester.userAgent === null
      ? {}
      : { userAgent: { summary: toEventText(requester.userAgent, 60), provenance: 'client' } }),
  };

  return `atc security ${JSON.stringify(fields)}`;
}

function toEventText(value: string, maxLength: number): string {
  return normalizeClientName(value, '', maxLength);
}
