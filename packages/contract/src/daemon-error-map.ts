import { z } from 'zod';
import { ERROR_CODES } from './light/error-codes';
import type { ErrorCode } from './light/error-codes';

// The detail an error carries as `data`, whose fields each code defines.
const ERROR_DATA_SCHEMA = z.record(z.string(), z.unknown()).optional();

// oxlint-disable-next-line typescript/no-empty-interface -- a declaration file names an interface where it spells out a type alias's every error code at each procedure
export interface DaemonErrorMap extends Readonly<
  Record<ErrorCode, { readonly data: typeof ERROR_DATA_SCHEMA }>
> {}

export const DAEMON_ERROR_MAP: DaemonErrorMap = buildErrorMap();

function buildErrorMap(): DaemonErrorMap {
  const map: Partial<Record<ErrorCode, { readonly data: typeof ERROR_DATA_SCHEMA }>> = {};

  for (const code of ERROR_CODES) {
    map[code] = { data: ERROR_DATA_SCHEMA };
  }

  if (!hasEveryCode(map)) {
    throw new Error('an error code has no entry in the error map');
  }

  return map;
}

function hasEveryCode(map: object): map is DaemonErrorMap {
  return ERROR_CODES.every((code) => Object.hasOwn(map, code));
}
