import type { CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError, EffectRemainsError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { BrokerAuthorityError } from './broker-authority-error';

// A credential broker's refusal or an authority refusal as the daemon error it answers.
export function toAuthRefusal(error: unknown, broker: Pick<CredentialBroker, 'describe'>): unknown {
  if (error instanceof DaemonError || error instanceof EffectRemainsError) {
    return error;
  }

  if (error instanceof BrokerAuthorityError) {
    return new DaemonError(error.code, error.message, error.data);
  }

  if (error instanceof CredentialBrokerError) {
    const upgrade = error.code === 'too_old' ? broker.describe.upgrade : undefined;

    return new DaemonError(
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
