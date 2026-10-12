import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';
import { z } from 'zod';
import { GRANT_SCOPES } from '../shared/grant-scope';
import { isAllowedRedirectURI } from './is-allowed-redirect-uri';

// atc has one user: the operator who runs it. better-auth needs an email for
// every user, so the owner gets one no mail ever reaches.
const OWNER_EMAIL = 'owner@atc.invalid';
const REDIRECT_URI = z.string().refine(isAllowedRedirectURI);

/**
 * The better-auth plugin that makes the operator the one user. Its endpoints
 * are server-only: better-auth refuses them over HTTP, so only atc's own
 * routes reach them, and only after checking what they guard.
 *
 * - `signInOwner` starts an owner session and sets its cookie. atc calls it
 *   once the operator has typed the right approval code; with the signed
 *   authorization query in the body, better-auth then resumes the
 *   authorization.
 * - `verifyMCPAccessToken` returns the introspection payload of an active
 *   access token and rejects any other token.
 * - `createFixedClient` registers a public client: no secret, PKCE required,
 *   and every scope atc grants open to request.
 */
export function buildOwnerPlugin() {
  return {
    id: 'atc-owner',
    endpoints: {
      signInOwner: createAuthEndpoint(
        '/atc/sign-in-owner',
        {
          method: 'POST',
          body: z.object({ oauth_query: z.string().optional() }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;

          const existing = await adapter.findUserByEmail(OWNER_EMAIL);

          const user =
            existing === null
              ? await adapter.createUser(
                  { email: OWNER_EMAIL, name: 'owner', emailVerified: true },
                  { method: 'admin' },
                )
              : existing.user;

          const session = await adapter.createSession(user.id);

          await setSessionCookie(ctx, { session, user });

          return ctx.json({ signedIn: true });
        },
      ),
      verifyMCPAccessToken: createAuthEndpoint(
        '/atc/verify-access-token',
        {
          method: 'POST',
          body: z.object({ token: z.string() }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const provider = ctx.context.getPlugin('oauth-provider');

          if (provider === null) {
            throw new Error('the oauth-provider plugin is not installed');
          }

          const payload = await getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken(
            ctx.body.token,
          );

          return ctx.json(payload);
        },
      ),
      createFixedClient: createAuthEndpoint(
        '/atc/create-fixed-client',
        {
          method: 'POST',
          body: z.object({
            name: z.string().min(1),
            redirectURIs: z.array(REDIRECT_URI).min(1),
          }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const clientID = generateRandomString(32, 'a-z', 'A-Z', '0-9');

          const now = new Date();

          await ctx.context.adapter.create({
            model: 'oauthClient',
            data: {
              clientId: clientID,
              name: ctx.body.name,
              redirectUris: ctx.body.redirectURIs,
              scopes: [...GRANT_SCOPES, 'offline_access'],
              clientCredentialsScopes: [],
              tokenEndpointAuthMethod: 'none',
              grantTypes: ['authorization_code', 'refresh_token'],
              responseTypes: ['code'],
              applicationType: ctx.body.redirectURIs.every((uri) => uri.startsWith('https:'))
                ? 'web'
                : 'native',
              requirePKCE: true,
              disabled: false,
              createdAt: now,
              updatedAt: now,
            },
          });

          return ctx.json({ clientID });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
