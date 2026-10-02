import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface DaemonRecord {
  readonly pid: number;
  readonly socketPath: string;
  readonly reporterSocketPath: string;
  readonly eventsSocketPath: string | null;
}

const RECORD_SCHEMA = z.object({
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  reporterSocketPath: z.string().min(1),
  eventsSocketPath: z.string().min(1).nullable(),
});

/**
 * Reads the record a running daemon keeps in its state directory: its pid
 * and the socket paths it listens on, which a client whose environment
 * computes other socket paths uses to find it. A missing, torn, or
 * malformed record reads as null; a record left by a crashed daemon still
 * parses, so a caller proves liveness by connecting.
 */
export function findDaemonRecord(recordPath: string): DaemonRecord | null {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }

  const parsed = RECORD_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
