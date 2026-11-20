import { AtcError } from '@atcx/contract/light';
import { SpritesApiError } from '../port/sprites-api-error';
import { buildHostRefusal } from './build-host-refusal';

export function toSpritesRefusal(error: unknown): AtcError {
  if (error instanceof AtcError) {
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
