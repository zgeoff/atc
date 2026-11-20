import type { CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError, EffectRemainsError } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';
import { BrokerAuthorityError } from './broker-authority-error';

export function toAuthRefusal(error: unknown, broker: Pick<CredentialBroker, 'describe'>): unknown {
  if (error instanceof AtcError || error instanceof EffectRemainsError) {
    return error;
  }

  if (error instanceof BrokerAuthorityError) {
    return new AtcError(error.code, error.message, error.data);
  }

  if (error instanceof CredentialBrokerError) {
    const upgrade = error.code === 'too_old' ? broker.describe.upgrade : undefined;

    return new AtcError(
      'host_unavailable',
      `the ${broker.describe.name} broker refused a runtime auth call: ${error.message}${upgrade === undefined ? '' : `; ${upgrade}`}`,
      {
        provider: error.provider,
        problem: error.brokerCode.toLowerCase(),
      },
    );
  }

  return error;
}
