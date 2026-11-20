import type { AuthProfile, CredentialRouter } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';
import type { ConnectorView, SpritesPort } from '../port/types';
import { toSpritesRefusal } from './to-sprites-refusal';

// A Sprites connector admits every sprite whose name starts with the connector's prefix,
// so a target is served only when its prefix starts with that prefix.
export function createConnectorRouter(
  api: Pick<SpritesPort, 'readConnectors'>,
  spritePrefix: string,
  apiURL: string,
): CredentialRouter {
  const readConnectors = async (): Promise<ReadonlyMap<string, ConnectorView>> => {
    try {
      const connectors = await api.readConnectors();

      return new Map(connectors.map((connector) => [connector.id, connector]));
    } catch (error) {
      throw toSpritesRefusal(error);
    }
  };

  return {
    hostPrefix: spritePrefix,

    verifyRoutes: async (profiles) => {
      const connectors = await readConnectors();

      for (const profile of profiles) {
        requireRoute(profile, connectors.get(profile.secret), spritePrefix);
      }
    },

    readRoutes: async (profiles) => {
      const connectors = await readConnectors();

      const routes: Record<string, string> = {};

      for (const profile of profiles) {
        const connector = requireRoute(profile, connectors.get(profile.secret), spritePrefix);

        routes[profile.name] = `${apiURL}/v1/gateway/${connector.provider}/${connector.id}`;
      }

      return routes;
    },
  };
}

function requireRoute(
  profile: AuthProfile,
  connector: ConnectorView | undefined,
  spritePrefix: string,
): ConnectorView {
  const refuse = (reason: string): AtcError =>
    new AtcError(
      'auth_target_unsupported',
      `auth profile '${profile.name}' has no route on sprites with the prefix '${spritePrefix}': ${reason}`,
      { problem: 'route_missing', profile: profile.name, connector: profile.secret },
    );

  if (connector === undefined) {
    throw refuse(`the organization holds no connector '${profile.secret}'`);
  }

  if (connector.namePrefix === null) {
    throw refuse(`connector '${connector.id}' has no access policy name prefix`);
  }

  if (!spritePrefix.startsWith(connector.namePrefix)) {
    throw refuse(
      `connector '${connector.id}' admits only sprites whose name starts with '${connector.namePrefix}'`,
    );
  }

  return connector;
}
