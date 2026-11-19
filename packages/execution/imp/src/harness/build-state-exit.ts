import type { HarnessExit } from '@atc/plugin-api';
import { z } from 'zod';

// The state impd gives for an imp that cannot run the session.
const IMP_STATE_SCHEMA = z.object({ state: z.string() });

// A sleeping imp suspends the session; any other state ends it.
export function buildStateExit(data: unknown): HarnessExit {
  const parsed = IMP_STATE_SCHEMA.safeParse(data);
  const state = parsed.success ? parsed.data.state : 'not running';

  return state === 'sleeping'
    ? { exitCode: 0, reason: 'suspended' }
    : { exitCode: 1, reason: 'ended', detail: `imp is ${state}` };
}
