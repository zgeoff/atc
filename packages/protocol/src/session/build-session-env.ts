import { SESSION_ENV_NAMES } from '@atcx/contract/light';
import type { SessionEnv } from './session-env';
import { toScopeFilePath } from './to-scope-file-path';

const RESOURCE_ATTRIBUTES = 'OTEL_RESOURCE_ATTRIBUTES';

export function buildSessionEnv(values: SessionEnv): Record<string, string> {
  const env: Record<string, string> = {};

  if (values.sessionID !== undefined) {
    env[SESSION_ENV_NAMES.sessionID] = values.sessionID;

    env[RESOURCE_ATTRIBUTES] = buildResourceAttributes(
      values.inheritedEnv?.[RESOURCE_ATTRIBUTES],
      values.sessionID,
    );
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
    env[SESSION_ENV_NAMES.scopeFile] = toScopeFilePath(values.sessionRecord);
  }

  return env;
}

const SESSION_ATTRIBUTE = 'atc.session.id';

// OpenTelemetry SDKs differ on which of two equal keys wins, so the session
// attribute a daemon started inside another session inherits is dropped.
function buildResourceAttributes(inherited: string | undefined, sessionID: string): string {
  const kept = (inherited ?? '')
    .split(',')
    .filter((pair) => pair.trim() !== '' && pair.split('=')[0]?.trim() !== SESSION_ATTRIBUTE);

  return [...kept, `${SESSION_ATTRIBUTE}=${encodeURIComponent(sessionID)}`].join(',');
}
