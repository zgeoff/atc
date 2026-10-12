import { z } from 'zod';
import { SESSION_DESCRIPTOR_SCHEMA } from './session-descriptor';

/**
 * The `session.spawn` answer: the spawned session, and the warnings its
 * workspace materialization raised, when it raised any.
 */
export const SPAWN_ANSWER_SCHEMA = z.object({
  session: SESSION_DESCRIPTOR_SCHEMA,
  warnings: z.array(z.string()).readonly().optional(),
});
