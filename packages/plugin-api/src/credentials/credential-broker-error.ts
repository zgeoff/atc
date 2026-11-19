type CredentialBrokerCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'unreachable'
  | 'too_old'
  | 'refused';

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
