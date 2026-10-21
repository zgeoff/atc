import { DaemonError } from '@atc/protocol/wire';

export function formatPickerError(error: unknown): string {
  return error instanceof DaemonError ? `${error.code}: ${error.message}` : String(error);
}

export function formatListFailure(error: unknown): string {
  if (!(error instanceof DaemonError)) {
    return String(error);
  }

  if (error.code === 'unknown_method') {
    return 'this daemon cannot list sources';
  }

  return error.message;
}

export function findAlternateURL(error: unknown): string | null {
  const alternates = error instanceof DaemonError ? error.data?.['alternates'] : undefined;
  const first: unknown = Array.isArray(alternates) ? alternates[0] : undefined;

  return typeof first === 'string' ? first : null;
}
