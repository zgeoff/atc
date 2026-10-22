import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { systemClock } from '@atc/core';
import {
  createEnrollmentToken,
  openMCPAuth,
  readPasskeyViews,
  removePasskey,
  resetPasskeys,
} from '@atc/mcp';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

export type PasskeysAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'enroll'; readonly reset: boolean }
  | { readonly kind: 'remove'; readonly id: string };

// The authorization server's database, and the command that prefixes every
// message, such as `atc passkeys`.
interface PasskeysTarget {
  readonly dbPath: string;
  readonly command: string;
}

interface PasskeysIO extends Pick<ProcessIO, 'print' | 'printError' | 'setExitCode'> {
  readonly now: () => number;
}

const PASSKEYS_IO: PasskeysIO = { ...PROCESS_IO, now: () => systemClock.now() };

export async function runPasskeys(
  action: PasskeysAction,
  target: PasskeysTarget,
  io: PasskeysIO = PASSKEYS_IO,
): Promise<void> {
  mkdirSync(dirname(target.dbPath), { recursive: true });

  const store = await openMCPAuth({
    dbPath: target.dbPath,
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  try {
    if (action.kind === 'enroll') {
      if (action.reset) {
        await resetPasskeys(store.db);

        io.print(
          'Removed every passkey and enrollment token and ended every browser sign-in. Grants stay.',
        );
      }

      const created = await createEnrollmentToken(store.db, io.now());

      io.print(`Enrollment token: ${created.token}`);

      io.print(
        `It enrolls one passkey and expires at ${new Date(created.expiresAt).toISOString()}. Open /enroll on the server's public URL in your browser and type it there.`,
      );

      return;
    }

    if (action.kind === 'remove') {
      const removed = await removePasskey(store.db, action.id);

      if (!removed) {
        io.printError(`${target.command} remove: no passkey has the ID '${action.id}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Removed passkey ${action.id} and ended every browser sign-in`);

      return;
    }

    const passkeys = await readPasskeyViews(store.db);

    if (passkeys.length === 0) {
      io.print(`No passkeys. Enroll one with: ${target.command} enroll`);

      return;
    }

    for (const passkey of passkeys) {
      io.print(
        `${passkey.id}  enrolled ${passkey.createdAt}  last used ${passkey.lastUsedAt ?? 'never'}`,
      );
    }
  } finally {
    await store.close();
  }
}
