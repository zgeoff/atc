import { z } from 'zod';
import { ERROR_CODES } from './wire/protocol';
import type { ErrorCode } from './wire/protocol';

// The detail an error carries as `data`, whose fields each code defines.
const ERROR_DATA_SCHEMA = z.record(z.string(), z.unknown()).optional();

type DaemonErrorMap = Readonly<Record<ErrorCode, { readonly data: typeof ERROR_DATA_SCHEMA }>>;

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
