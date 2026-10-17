import { DaemonError } from '@atc/protocol/wire';

export function buildTargetForbiddenError(target: string): DaemonError {
  return new DaemonError(
    'target_forbidden',
    `this client may not use execution target '${target}'. Grant it to the client under principals in config.json and restart the daemon`,
    { target },
  );
}
