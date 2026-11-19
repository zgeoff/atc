import { DaemonError } from '@atc/protocol/wire';
import { EngineError } from '../engine/engine-error';
import { EngineUnreachableError } from '../engine/engine-unreachable-error';
import { buildHostRefusal } from './build-host-refusal';

export function toDockerRefusal(error: unknown, socket: string): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  if (error instanceof EngineUnreachableError) {
    return buildHostRefusal('engine_unreachable', error.message, { socket });
  }

  const detail = error instanceof Error ? error.message : String(error);

  return buildHostRefusal('engine_error', `the Docker Engine refused: ${detail}`, {
    status: error instanceof EngineError ? error.status : null,
  });
}
