import { AtcError } from '@atcx/contract/light';

export function buildTargetForbiddenError(target: string): AtcError {
  return new AtcError(
    'target_forbidden',
    `this client may not use execution target '${target}'. Grant it to the client under principals in config.json and restart the daemon`,
    { target },
  );
}
