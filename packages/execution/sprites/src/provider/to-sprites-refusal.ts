import { DaemonError } from '@atc/protocol/wire';
import { SpritesApiError } from '../port/sprites-api-error';
import { buildHostRefusal } from './build-host-refusal';

export function toSpritesRefusal(error: unknown): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  const status = error instanceof SpritesApiError ? error.status : null;
  const detail = error instanceof Error ? error.message : String(error);

  return buildHostRefusal(
    'api_error',
    `the Sprites API refused${status === null ? '' : ` (status ${status})`}: ${detail}`,
    { status },
  );
}
