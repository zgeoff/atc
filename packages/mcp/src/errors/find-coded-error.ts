import { isRecord } from '@atc/core';

interface CodedError {
  readonly code: string;
  readonly data: Readonly<Record<string, unknown>>;
}

// The code and data of an error from a router call. The in-process client throws an oRPC error,
// where a daemon connection throws an AtcError, so only the code property tells them apart.
export function findCodedError(error: unknown): CodedError | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return null;
  }

  const data: unknown = 'data' in error ? error.data : undefined;

  return { code: error.code, data: isRecord(data) ? data : {} };
}
