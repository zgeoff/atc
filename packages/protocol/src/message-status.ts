import { z } from 'zod';

/**
 * Where an inbox message stands: waiting for its session's tap, delivered
 * to it, or answered.
 */
export const MESSAGE_STATUS_SCHEMA = z.enum(['queued', 'delivered', 'answered']);

export type MessageStatus = z.output<typeof MESSAGE_STATUS_SCHEMA>;
