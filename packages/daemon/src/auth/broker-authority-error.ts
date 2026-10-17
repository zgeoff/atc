type BrokerAuthorityCode =
  | 'auth_impd_too_old'
  | 'auth_token_scope'
  | 'auth_token_too_broad'
  | 'auth_imp_out_of_scope'
  | 'auth_secret_not_grantable'
  | 'auth_runtime_mismatch';

export class BrokerAuthorityError extends Error {
  readonly code: BrokerAuthorityCode;

  readonly data: Readonly<Record<string, unknown>>;

  constructor(code: BrokerAuthorityCode, message: string, data: Readonly<Record<string, unknown>>) {
    super(message);

    this.code = code;
    this.data = data;
    this.name = 'BrokerAuthorityError';
  }
}
