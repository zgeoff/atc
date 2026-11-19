import type { ImpdOutput } from '../impd/impd-procedure';
import { ImpPortError } from '../port/imp-port-error';

export function requireGuestScratchDir(
  info: Pick<ImpdOutput<'system.info'>, 'version' | 'guest'>,
): string {
  if (info.guest === undefined) {
    throw new ImpPortError(
      'IMPD_OUTDATED',
      `impd ${info.version} declares no guest scratch folder; upgrade impd, or set the target's guestDir`,
      { version: info.version },
    );
  }

  return info.guest.scratchDir;
}
