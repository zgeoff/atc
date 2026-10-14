import { DaemonError } from '@atc/protocol/daemon-error';
import { z } from 'zod';

/**
 * The idempotency key a spawn or message tool call may carry, as its input
 * schema lists it.
 */
export const IDEMPOTENCY_KEY_FIELD = z
  .string()
  .min(1)
  .max(180)
  .optional()
  .describe(
    'A key, unique to this call, that makes a retry safe: retrying with the same key and arguments acts only once and returns what the first call made as it stands now, and the same key with different arguments is refused as idempotency_conflict. A refused call keeps no key, so a retry runs again, and atc forgets a key 24 hours after its call completed. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters',
  );

/**
 * Reads a tool call's idempotency key, refusing one outside the input
 * schema as `bad_args` before the call reaches the daemon.
 */
export function parseIdempotencyKey(value: unknown): string | undefined {
  const parsed = IDEMPOTENCY_KEY_FIELD.safeParse(value);

  if (!parsed.success) {
    throw new DaemonError('bad_args', 'idempotencyKey must be a string of 1 to 180 characters');
  }

  return parsed.data;
}
