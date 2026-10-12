/**
 * Why impd's credential broker may not be used for a session, or why atc
 * may not clean up after one:
 *
 * - `auth_impd_too_old`: impd lacks grantable tokens, secret rebinds or
 *   exec requirements, or oauth secrets for a binding that holds one.
 * - `auth_token_scope`: the token's scope is below `manage`.
 * - `auth_token_too_broad`: the token can reach imps outside atc's
 *   namespace, through no imp patterns or a pattern whose literal text
 *   before its first `*` does not start with the namespace prefix.
 * - `auth_imp_out_of_scope`: an imp the call touches is outside the
 *   token's patterns.
 * - `auth_secret_not_grantable`: a bound secret is not on the token's
 *   grantable list.
 * - `auth_runtime_mismatch`: the imp under the recorded name has another
 *   id than the one recorded.
 */
export type BrokerAuthorityCode =
  | 'auth_impd_too_old'
  | 'auth_token_scope'
  | 'auth_token_too_broad'
  | 'auth_imp_out_of_scope'
  | 'auth_secret_not_grantable'
  | 'auth_runtime_mismatch';

/**
 * A refusal to provision through impd's credential broker or to clean up
 * after it, carrying its code and the detail the code defines.
 */
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
