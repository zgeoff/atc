/**
 * Why a credential broker call failed:
 *
 * - `not_found`: the host, secret, or grant the call names is gone.
 * - `forbidden`: the provider's identity may not make the call.
 * - `unauthorized`: the broker refused the provider's credential.
 * - `unreachable`: the broker never answered, so the call may or may not
 *   have taken effect.
 * - `refused`: the broker refused the call for another reason.
 */
type CredentialBrokerCode = 'not_found' | 'forbidden' | 'unauthorized' | 'unreachable' | 'refused';

// The broker's own code for a failure, and the data it gave.
interface CredentialBrokerErrorOptions {
  readonly brokerCode: string;
  readonly data?: unknown;
}

/**
 * A credential broker call that failed, with atc's code for the failure,
 * the broker's own code for it, and the data the broker gave.
 */
export class CredentialBrokerError extends Error {
  readonly code: CredentialBrokerCode;

  readonly brokerCode: string;

  readonly data: unknown;

  constructor(code: CredentialBrokerCode, message: string, options: CredentialBrokerErrorOptions) {
    super(message);

    this.code = code;
    this.brokerCode = options.brokerCode;
    this.data = options.data;
    this.name = 'CredentialBrokerError';
  }
}
