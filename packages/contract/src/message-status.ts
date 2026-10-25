import { z } from 'zod';

export const MESSAGE_STATUS_SCHEMA = z.enum(['queued', 'delivered', 'answered', 'unanswered']);
