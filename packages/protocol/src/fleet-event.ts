import { z } from 'zod';

/**
 * One entry of the fleet's event trail as `events.read` pages it: its
 * cursor, when it happened, the session and its name then, the kind, a
 * detail, and the message or note label it concerns.
 */
export const FLEET_EVENT_SCHEMA = z.object({
  cursor: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  detail: z.string().nullable(),
  message: z.string().optional(),
  label: z.string().optional(),
});

export type FleetEvent = z.output<typeof FLEET_EVENT_SCHEMA>;
