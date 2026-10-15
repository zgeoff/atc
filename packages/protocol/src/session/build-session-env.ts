import type { SessionEnv } from './session-env';
import { SESSION_ENV_NAMES } from './session-env-names';

/**
 * The variables that give a harness its session environment, holding only
 * the fields that are set.
 */
export function buildSessionEnv(values: SessionEnv): Record<string, string> {
  const env: Record<string, string> = {};

  if (values.sessionID !== undefined) {
    env[SESSION_ENV_NAMES.sessionID] = values.sessionID;
  }

  if (values.socket !== undefined) {
    env[SESSION_ENV_NAMES.socket] = values.socket;
  }

  if (values.bridge === true) {
    env[SESSION_ENV_NAMES.bridge] = '1';
  }

  if (values.outbox !== undefined) {
    env[SESSION_ENV_NAMES.outbox] = values.outbox;
  }

  if (values.sessionRecord !== undefined) {
    env[SESSION_ENV_NAMES.sessionRecord] = values.sessionRecord;
  }

  return env;
}
