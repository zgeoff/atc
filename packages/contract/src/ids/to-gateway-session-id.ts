import { z } from 'zod';
import type { GatewaySessionID } from './gateway-session-id';

const GATEWAY_SESSION_ID_SCHEMA = z.string().brand<'GatewaySessionID'>();

export function toGatewaySessionID(id: string): GatewaySessionID {
  return GATEWAY_SESSION_ID_SCHEMA.parse(id);
}
