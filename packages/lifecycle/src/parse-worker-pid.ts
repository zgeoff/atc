import { z } from 'zod';

const WORKER_PID_SCHEMA = z.strictObject({ workerPID: z.number().int().positive() });

/**
 * The pid a restart worker announces on the first line of its run log, as a
 * JSON record holding only `workerPID`, or null for any other line.
 */
export function parseWorkerPID(line: string): number | null {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = WORKER_PID_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data.workerPID : null;
}
