import { z } from 'zod';

const WORKER_PID_SCHEMA = z.strictObject({ workerPID: z.number().int().positive() });

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
