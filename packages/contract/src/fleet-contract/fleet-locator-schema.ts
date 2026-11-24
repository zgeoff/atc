import { z } from 'zod';

export const FLEET_LOCATOR_SCHEMA = z.object({
  daemon: z.string(),
  incarnation: z.string(),
  targetID: z.string(),
});
