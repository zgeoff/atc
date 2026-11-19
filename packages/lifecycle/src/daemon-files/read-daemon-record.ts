import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface DaemonRecord {
  readonly pid: number;
  readonly socketPath: string;
  readonly reporterSocketPath: string;
  readonly eventsSocketPath: string | null;

  // The port the TCP listener bound, or null without one.
  readonly listenPort: number | null;

  // The protocol version the daemon speaks, or null for a daemon whose
  // record holds none, which speaks the older line protocol.
  readonly protocol: number | null;
}

const RECORD_SCHEMA = z.object({
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  reporterSocketPath: z.string().min(1),
  eventsSocketPath: z.string().min(1).nullable(),
  listenPort: z.number().int().min(1).max(65_535).nullable().default(null),
  protocol: z.number().int().positive().nullable().default(null),
});

// a record left by a crashed daemon still parses, so a caller proves
// liveness by connecting.
export function readDaemonRecord(recordPath: string): DaemonRecord | null {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }

  const parsed = RECORD_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
