import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import invariant from 'tiny-invariant';
import type { VerifiedAccess } from '../auth/types';

interface ModernMCPHandlerDeps {
  readonly createServer: (access: VerifiedAccess) => McpServer;
}

export interface ModernMCPHandler {
  readonly answer: (
    request: Request,
    access: VerifiedAccess,
    authInfo: AuthInfo,
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
}

// Serves the stateless `2026-07-28` revision, whose requests each carry their
// protocol version in `_meta`. The SDK builds a server for each request, and
// that server serves the access the request's token verified to.
export function createModernMCPHandler(deps: ModernMCPHandlerDeps): ModernMCPHandler {
  const accesses = new WeakMap<Request, VerifiedAccess>();

  const handler = createMcpHandler(
    (context) => {
      const access =
        context.requestInfo === undefined ? undefined : accesses.get(context.requestInfo);

      invariant(access, 'the SDK built a server for a request that carries no verified access');

      return deps.createServer(access);
    },
    { legacy: 'reject' },
  );

  return {
    answer: (request, access, authInfo) => {
      accesses.set(request, access);

      return handler.fetch(request, { authInfo });
    },
    close: () => handler.close(),
  };
}
