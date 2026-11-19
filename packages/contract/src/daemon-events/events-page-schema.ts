import { z } from 'zod';
import { FLEET_EVENT_SCHEMA } from './fleet-event-schema';

export const EVENTS_PAGE_SCHEMA = z.object({
  events: z.array(FLEET_EVENT_SCHEMA).readonly(),
  cursor: z.string(),
  more: z.boolean(),
});
