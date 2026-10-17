import type { ImpSecret } from './imp-port';
import type { ImpdOutput } from './impd-contract';

type ImpdSecret = ImpdOutput<'secrets.list'>[number];

type ImpdSecretRule = ImpdSecret['rules'][number];

type ImpdOAuthState = NonNullable<ImpdSecret['oauth']>;

export type ImpdListedSecret = Pick<ImpdSecret, 'name' | 'kind' | 'imps'> & {
  readonly rules: readonly Pick<ImpdSecretRule, 'host' | 'header' | 'scheme' | 'user'>[];
  readonly oauth?: Pick<ImpdOAuthState, 'status' | 'idClaims'> | undefined;
};

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
