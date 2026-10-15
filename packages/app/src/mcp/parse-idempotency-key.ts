import { DaemonError } from '@atc/protocol/wire';
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
    'A key, unique to this call, that makes a retry safe: retrying with the same key and arguments acts only once and returns what the first call made as it stands now, and the same key with different arguments is refused as idempotency_conflict. A call refused with an error such as session_dead leaves no key on the daemon, so retry it under a new key: the same key runs the call again on a daemon reached directly, but under the gateway it returns outcome_unknown and runs nothing. atc forgets a key 24 hours after its call completed. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters',
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
