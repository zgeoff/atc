import { z } from 'zod';

/**
 * Where an inbox message stands: waiting for its session's tap, delivered
 * to it, answered, or unanswered: the turn that carried it ended without an
 * answer.
 */
export const MESSAGE_STATUS_SCHEMA = z.enum(['queued', 'delivered', 'answered', 'unanswered']);

export type MessageStatus = z.output<typeof MESSAGE_STATUS_SCHEMA>;
