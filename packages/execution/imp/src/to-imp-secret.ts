import type { ImpSecret } from './imp-port';
import type { ImpdOutput } from './impd-contract';

type ImpdSecret = ImpdOutput<'secrets.list'>[number];

type ImpdSecretRule = ImpdSecret['rules'][number];

type ImpdOAuthState = NonNullable<ImpdSecret['oauth']>;

/**
 * A secret as impd lists it, cut to the fields the port reads: its rules
 * without their upstreams, and an oauth secret's sign-in status and ID
 * token claims without the rest of its state.
 */
export type ImpdListedSecret = Pick<ImpdSecret, 'name' | 'kind' | 'imps'> & {
  readonly rules: readonly Pick<ImpdSecretRule, 'host' | 'header' | 'scheme' | 'user'>[];
  readonly oauth?: Pick<ImpdOAuthState, 'status' | 'idClaims'> | undefined;
};

/**
 * A secret in the port's terms, with an oauth secret's sign-in status and
 * ID token claims and none of its other state.
 */
export function toImpSecret(secret: ImpdListedSecret): ImpSecret {
  const listed: ImpSecret = {
    name: secret.name,
    kind: secret.kind,
    rules: secret.rules.map((rule) => ({
      host: rule.host,
      header: rule.header,
      scheme: rule.scheme,
      ...(rule.user === undefined ? {} : { user: rule.user }),
    })),
    imps: [...secret.imps],
  };

  const oauth = secret.oauth;

  return oauth === undefined
    ? listed
    : { ...listed, oauth: { status: oauth.status, idClaims: oauth.idClaims } };
}
