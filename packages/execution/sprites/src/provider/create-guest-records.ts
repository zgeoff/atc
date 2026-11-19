import { makeKeyedLock } from '@atc/core';
import { z } from 'zod';
import type { SpritesPort } from '../port/types';
import { BOOT_ID_PATH } from './boot-id-path';

const HOST_RECORD_SCHEMA = z.object({ target: z.string(), host: z.string(), daemon: z.string() });

// the exec's id, and the boot of the sprite it ran under; exec ids mean nothing after a reboot
const EXEC_RECORD_SCHEMA = z.object({ exec: z.string(), boot: z.string() });

const SESSION_RECORD_SCHEMA = z.object({
  harness: EXEC_RECORD_SCHEMA.nullable(),
  mux: EXEC_RECORD_SCHEMA.nullable(),
});

export type HostRecord = z.infer<typeof HOST_RECORD_SCHEMA>;

type SessionRecord = z.infer<typeof SESSION_RECORD_SCHEMA>;

export interface GuestRecords {
  readonly readHostRecord: (sprite: string) => Promise<HostRecord | null>;
  readonly writeHostRecord: (sprite: string, record: HostRecord) => Promise<void>;
  readonly readSessionRecord: (sprite: string, session: string) => Promise<SessionRecord | null>;

  // reads the session's record, applies the change and writes it back, one turn at a time
  readonly updateSessionRecord: (
    sprite: string,
    session: string,
    change: (record: SessionRecord) => SessionRecord,
  ) => Promise<void>;
  readonly readBootID: (sprite: string) => Promise<string>;
}

// The files that the provider keeps in a sprite's guest folder: the host record, the exec ids of
// each session, and the boot id they were recorded under. A file that holds no valid record reads
// as none.
export function createGuestRecords(api: SpritesPort, guestDir: string): GuestRecords {
  const withTurn = makeKeyedLock();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const readJSON = async <T>(
    sprite: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    const bytes = await api.readFile(sprite, path);

    if (bytes === null) {
      return null;
    }

    try {
      const parsed = schema.safeParse(JSON.parse(decoder.decode(bytes)));

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const buildSessionPath = (session: string): string => `${guestDir}/state/${session}.json`;

  const readSessionRecord = (sprite: string, session: string) =>
    readJSON(sprite, buildSessionPath(session), SESSION_RECORD_SCHEMA);

  return {
    readHostRecord: (sprite) => readJSON(sprite, `${guestDir}/host.json`, HOST_RECORD_SCHEMA),

    writeHostRecord: (sprite, record) => {
      const bytes = encoder.encode(JSON.stringify(record));

      return api.writeFile(sprite, `${guestDir}/host.json`, bytes, 0o600);
    },

    readSessionRecord,

    updateSessionRecord: (sprite, session, change) =>
      withTurn(`${sprite}/${session}`, async () => {
        const stored = await readSessionRecord(sprite, session);

        const changed = change(stored ?? { harness: null, mux: null });
        const bytes = encoder.encode(JSON.stringify(changed));

        await api.writeFile(sprite, buildSessionPath(session), bytes, 0o600);
      }),

    readBootID: async (sprite) => {
      const bytes = await api.readFile(sprite, BOOT_ID_PATH);

      return bytes === null ? '' : decoder.decode(bytes).trim();
    },
  };
}
