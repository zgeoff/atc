import type { HarnessExit } from '@atc/plugin-api';
import { z } from 'zod';

const IMP_STATE_SCHEMA = z.object({ state: z.string() });

export function buildStateExit(data: unknown): HarnessExit {
  const parsed = IMP_STATE_SCHEMA.safeParse(data);
  const state = parsed.success ? parsed.data.state : 'not running';

  return state === 'sleeping'
    ? { exitCode: 0, reason: 'suspended' }
    : { exitCode: 1, reason: 'ended', detail: `imp is ${state}` };
}
