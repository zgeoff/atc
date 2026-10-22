// `forbidden`: the provider's identity may not make the call; `unauthorized`:
// the broker refused its credential; `unreachable`: the broker never answered,
// so the call may or may not have taken effect.
type CredentialBrokerCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'unreachable'

  // the broker is older than the oldest broker this atc supports.
  | 'too_old'
  | 'refused';

// The kind of the execution provider whose broker failed, the broker's own
// code for the failure, and the data it gave.
interface CredentialBrokerErrorOptions {
  readonly provider: string;
  readonly brokerCode: string;
  readonly data?: unknown;
}

export class CredentialBrokerError extends Error {
  readonly code: CredentialBrokerCode;

  readonly provider: string;

  readonly brokerCode: string;

  readonly data: unknown;

  constructor(code: CredentialBrokerCode, message: string, options: CredentialBrokerErrorOptions) {
    super(message);

    this.code = code;
    this.provider = options.provider;
    this.brokerCode = options.brokerCode;
    this.data = options.data;
    this.name = 'CredentialBrokerError';
  }
}
