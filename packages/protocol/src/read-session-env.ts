import type { SessionEnv } from './session-env';
import { SESSION_ENV_NAMES } from './session-env-names';

/**
 * The session environment a process inherited. An unset or empty variable
 * leaves its field out, and only `1` marks the socket as the bridge.
 */
export function readSessionEnv(env: Readonly<Record<string, string | undefined>>): SessionEnv {
  const read = (name: string): string | undefined => {
    const value = env[name];

    return value === undefined || value === '' ? undefined : value;
  };

  const sessionID = read(SESSION_ENV_NAMES.sessionID);
  const socket = read(SESSION_ENV_NAMES.socket);
  const outbox = read(SESSION_ENV_NAMES.outbox);
  const sessionRecord = read(SESSION_ENV_NAMES.sessionRecord);

  return {
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(socket === undefined ? {} : { socket }),
    ...(env[SESSION_ENV_NAMES.bridge] === '1' ? { bridge: true } : {}),
    ...(outbox === undefined ? {} : { outbox }),
    ...(sessionRecord === undefined ? {} : { sessionRecord }),
  };
}
