import type { ImpPort, ImpView } from './imp-port';

/**
 * What a provider whose hosts can reach impd's credential broker offers
 * runtime auth: the literal start of every imp name it builds, the imp a
 * host key runs on, impd's identity, secret and grant calls, and creating
 * and destroying a host's imp the way the provider itself does. A
 * destroy that finds no imp counts as done.
 */
export interface BrokerAuthHost {
  readonly impPrefix: string;
  readonly port: Pick<
    ImpPort,
    | 'readFeatures'
    | 'readIdentity'
    | 'readSecrets'
    | 'readGrants'
    | 'createGrant'
    | 'removeGrant'
    | 'readImp'
  >;
  readonly getImpName: (hostKey: string) => string;
  readonly createImp: (hostKey: string) => Promise<ImpView>;
  readonly destroyImp: (hostKey: string) => Promise<void>;
}
