import { z } from 'zod';

export const GATEWAY_SESSION_ID_SCHEMA = z.string().brand<'GatewaySessionID'>();
