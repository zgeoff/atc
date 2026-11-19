import { localMCPClient } from './constants.ts';

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
