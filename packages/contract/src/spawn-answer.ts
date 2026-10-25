import { z } from 'zod';
import { SESSION_DESCRIPTOR_SCHEMA } from './session-descriptor';

export const SPAWN_ANSWER_SCHEMA = z.object({
  session: SESSION_DESCRIPTOR_SCHEMA,
  warnings: z.array(z.string()).readonly().optional(),
});
