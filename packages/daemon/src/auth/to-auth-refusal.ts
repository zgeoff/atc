import { CredentialBrokerError, EffectRemainsError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { BrokerAuthorityError } from './broker-authority-error';

// An impd refusal or an authority refusal as the daemon error it answers.
export function toAuthRefusal(error: unknown): unknown {
  if (error instanceof DaemonError || error instanceof EffectRemainsError) {
    return error;
  }

  if (error instanceof BrokerAuthorityError) {
    return new DaemonError(error.code, error.message, error.data);
  }

  if (error instanceof CredentialBrokerError) {
    return new DaemonError(
      'host_unavailable',
      `impd refused a runtime auth call: ${error.message}`,
      {
        provider: 'imp',
        problem: error.brokerCode.toLowerCase(),
      },
    );
  }

  return error;
}
