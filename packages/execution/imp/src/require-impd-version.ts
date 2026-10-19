import { ImpPortError } from './imp-port-error';
import { MIN_IMPD_VERSION } from './min-impd-version';

export function requireImpdVersion(version: string): void {
  let order: -1 | 0 | 1;

  try {
    order = Bun.semver.order(version, MIN_IMPD_VERSION);
  } catch {
    throw new ImpPortError(
      'IMPD_OUTDATED',
      `impd reports version '${version}', which atc cannot compare with ${MIN_IMPD_VERSION}, the oldest impd this atc supports; upgrade impd`,
      { version, minimum: MIN_IMPD_VERSION },
    );
  }

  if (order < 0) {
    throw new ImpPortError(
      'IMPD_OUTDATED',
      `impd ${version} is older than ${MIN_IMPD_VERSION}, the oldest impd this atc supports; upgrade impd`,
      { version, minimum: MIN_IMPD_VERSION },
    );
  }
}
