import type { z } from 'zod';

export type GatewaySessionID = string & z.$brand<'GatewaySessionID'>;
