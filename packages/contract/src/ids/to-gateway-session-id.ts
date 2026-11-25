import type { GatewaySessionID } from './gateway-session-id';
import { GATEWAY_SESSION_ID_SCHEMA } from './gateway-session-id-schema';

export function toGatewaySessionID(id: string): GatewaySessionID {
  return GATEWAY_SESSION_ID_SCHEMA.parse(id);
}
