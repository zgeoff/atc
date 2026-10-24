import type { z } from 'zod';

export type AgentSessionID = string & z.$brand<'AgentSessionID'>;
