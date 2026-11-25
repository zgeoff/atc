import { z } from 'zod';

export const DAEMON_STATE_SCHEMA = z.enum([
  'up',
  'down',
  'unauthorized',
  'changed',
  'mismatched',
  'refused',
]);
