import type { ResolvedAuthSecret } from '@atc/config';
import type { CredentialBroker } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';

export function toSignInRefusal(
  error: unknown,
  broker: Pick<CredentialBroker, 'describe'>,
  secrets: readonly ResolvedAuthSecret[],
): unknown {
  const renewSecret = broker.describe.renewSecret;

  if (
    !(error instanceof AtcError) ||
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

  return new AtcError(
    error.code,
    `${error.message}; ${renewSecret(bound.secret, bound.kind)}`,
    error.data,
  );
}
