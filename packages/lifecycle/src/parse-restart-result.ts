import { RESTART_RESULT_SCHEMA } from '@atcx/contract';
import type { RestartResult } from '@atcx/contract';

export function parseRestartResult(line: string): RestartResult | null {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = RESTART_RESULT_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
