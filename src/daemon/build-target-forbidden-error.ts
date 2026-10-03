import { DaemonError } from '../protocol/daemon-error';

/**
 * The refusal of a spawn to a target the principal may not use, which a
 * replay of a held spawn key outside the principal's reach answers with too.
 */
export function buildTargetForbiddenError(target: string): DaemonError {
  return new DaemonError(
    'target_forbidden',
    `this client may not use execution target '${target}'. Grant it to the client under principals in config.json and restart the daemon`,
    { target },
  );
}
