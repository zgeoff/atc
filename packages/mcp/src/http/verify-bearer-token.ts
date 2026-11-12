import { SERVICE_TOKEN_PREFIX } from '../auth/service-token-prefix';
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { verifyAccessToken } from './verify-access-token';

// A bearer with the service prefix is checked against the token file alone,
// and any other bearer against the authorization server's database alone.
export function verifyBearerToken(
  ctx: HTTPServerContext,
  token: string,
): Promise<VerifiedAccess | null> {
  if (token.startsWith(SERVICE_TOKEN_PREFIX)) {
    return Promise.resolve(ctx.serviceTokens?.verify(token) ?? null);
  }

  return verifyAccessToken(ctx, token);
}
