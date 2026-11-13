import type { PasskeyID } from '@atc/mcp';
import { toTagged } from '@zgeoff/std';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';
import { withMCPAuthAdmin } from './with-mcp-auth-admin';

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

export async function runPasskeys(
  action: PasskeysAction,
  target: PasskeysTarget,
  io: Pick<ProcessIO, 'print' | 'printError' | 'setExitCode'> = PROCESS_IO,
): Promise<void> {
  await withMCPAuthAdmin(target.dbPath, async (admin) => {
    if (action.kind === 'enroll') {
      if (action.reset) {
        await admin.passkeys.reset();

        io.print(
          'Removed every passkey and enrollment token and ended every browser sign-in. Grants stay.',
        );
      }

      const token = await admin.passkeys.createEnrollmentToken();

      io.print(`Enrollment token: ${token}`);

      io.print(
        "It enrolls one passkey. Open /enroll on the server's public URL in your browser and type it there.",
      );

      return;
    }

    if (action.kind === 'remove') {
      const passkeys = await admin.passkeys.list();

      if (!passkeys.some((passkey) => passkey.id === action.id)) {
        io.printError(`${target.command} remove: no passkey has the ID '${action.id}'`);
        io.setExitCode(1);

        return;
      }

      await admin.passkeys.remove(toTagged<PasskeyID>(action.id));

      io.print(`Removed passkey ${action.id} and ended every browser sign-in`);

      return;
    }

    const passkeys = await admin.passkeys.list();

    if (passkeys.length === 0) {
      io.print(`No passkeys. Enroll one with: ${target.command} enroll`);

      return;
    }

    for (const passkey of passkeys) {
      io.print(
        `${passkey.id}  enrolled ${passkey.createdAt}  last used ${passkey.lastUsedAt ?? 'never'}`,
      );
    }
  });
}
