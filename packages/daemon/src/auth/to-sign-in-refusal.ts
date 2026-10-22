import type { ResolvedAuthSecret } from '@atc/config';
import type { CredentialBroker } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export function toSignInRefusal(
  error: unknown,
  broker: Pick<CredentialBroker, 'describe'>,
  secrets: readonly ResolvedAuthSecret[],
): unknown {
  const renewSecret = broker.describe.renewSecret;

  if (
    !(error instanceof DaemonError) ||
    error.code !== 'auth_signin_needed' ||
    renewSecret === undefined
  ) {
    return error;
  }

  const name = error.data?.['secret'];
  const bound = secrets.find((secret) => secret.secret === name);

  if (bound === undefined) {
    return error;
  }

  return new DaemonError(
    error.code,
    `${error.message}; ${renewSecret(bound.secret, bound.kind)}`,
    error.data,
  );
}
