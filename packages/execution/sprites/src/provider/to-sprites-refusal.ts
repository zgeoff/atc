import { DaemonError } from '@atc/protocol/wire';
import { SpritesApiError } from '../port/sprites-api-error';
import { buildHostRefusal } from './build-host-refusal';

// A Sprites API error, with its status and the API's own message, as the refusal a caller sees.
// An error that is already a refusal stays as it is.
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
