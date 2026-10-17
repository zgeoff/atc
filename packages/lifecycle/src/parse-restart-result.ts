import { z } from 'zod';

export interface RestartFailedRow {
  readonly name: string;
  readonly id: string;
  readonly reason: string;
}

interface RestartInterruptedRow {
  readonly name: string;
  readonly id: string;
}

export interface RestartResult {
  readonly runID: string;
  readonly code: number;
  readonly pid: number | null;
  readonly build: string | null;
  readonly listenPort: number | null;
  readonly restored: number;
  readonly total: number;
  readonly failed: readonly RestartFailedRow[];
  readonly interrupted: readonly RestartInterruptedRow[];
  readonly error: string | null;
}

const FAILED_ROW_SCHEMA = z.object({ name: z.string(), id: z.string(), reason: z.string() });
const INTERRUPTED_ROW_SCHEMA = z.object({ name: z.string(), id: z.string() });

const RESULT_SCHEMA = z.object({
  runID: z.string(),
  code: z.number().int(),
  pid: z.number().int().nullable(),
  build: z.string().nullable(),
  listenPort: z.number().int().nullable(),
  restored: z.number().int(),
  total: z.number().int(),
  failed: z.array(FAILED_ROW_SCHEMA),
  interrupted: z.array(INTERRUPTED_ROW_SCHEMA),
  error: z.string().nullable(),
});

export function parseRestartResult(line: string): RestartResult | null {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = RESULT_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
