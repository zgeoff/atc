import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { systemClock } from '@atc/core';
import { collectPasskeys } from './mcp/collect-passkeys';
import { createEnrollmentToken } from './mcp/create-enrollment-token';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { removePasskey } from './mcp/remove-passkey';
import { resetPasskeys } from './mcp/reset-passkeys';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

type PasskeysAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'enroll'; readonly reset: boolean }
  | { readonly kind: 'remove'; readonly id: string };

// The authorization server's database, and the command that prefixes every
// message, such as `atc passkeys`.
interface PasskeysTarget {
  readonly dbPath: string;
  readonly command: string;
}

// Where the command's lines and its exit code go, and the time tokens
// expire from: the console, the process, and the system clock by default.
interface PasskeysIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly now: () => number;
}

const PROCESS_IO: PasskeysIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  now: () => systemClock.now(),
};

export async function runPasskeys(
  action: PasskeysAction,
  target: PasskeysTarget,
  io: PasskeysIO = PROCESS_IO,
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

    const passkeys = await collectPasskeys(store.db);

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
