import { localMCPClient } from './constants.ts';

// The service-token file of the server whose public origin is `origin`: the run's one service
// client, with every scope and the digest of its secret. The file holds no secret.
export function buildServiceTokenFile(origin: string, digest: string) {
  return {
    resource: `${origin}/mcp`,
    clients: {
      [localMCPClient.name]: {
        scopes: ['read', 'message', 'spawn', 'kill'],
        secretDigests: [digest],
      },
    },
  };
}
