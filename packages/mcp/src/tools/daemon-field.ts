import { z } from 'zod';

export const DAEMON_FIELD = z
  .string()
  .optional()
  .describe(
    'The atc daemon to run on, one of the names atc_daemons_list returns. Omit it to use the default daemon. A daemon that is down answers daemon_unavailable; atc never runs the call on another daemon instead.',
  );
