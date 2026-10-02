import { DaemonError } from '../protocol/daemon-error';
import { deriveTokenHash } from './derive-token-hash';
import { mintToken } from './mint-token';
import type { HTTPServerContext } from './types';
import { verifyPKCE } from './verify-pkce';

/**
 * Answers `POST /token` for the two grant types atc issues: exchanging an
 * authorization code, and rotating a refresh token. Tokens leave atc only in
 * this response; the daemon receives their hashes.
 */
export async function answerTokenRequest(ctx: HTTPServerContext, body: string): Promise<Response> {
  const form = new URLSearchParams(body);

  const grantType = form.get('grant_type');
  const clientID = form.get('client_id');
  const resource = form.get('resource');

  if (clientID === null || clientID === '') {
    return buildTokenError(400, 'invalid_request', 'client_id is required');
  }

  if (resource !== null && resource !== ctx.resource) {
    return buildTokenError(400, 'invalid_target', `atc serves one resource: ${ctx.resource}`);
  }

  if (grantType === 'authorization_code') {
    const exchanged = await answerCodeExchange(ctx, clientID, {
      code: form.get('code') ?? '',
      verifier: form.get('code_verifier') ?? '',
      redirectURI: form.get('redirect_uri'),
    });

    return exchanged;
  }

  if (grantType === 'refresh_token') {
    const refreshed = await answerRefresh(ctx, clientID, form.get('refresh_token') ?? '');

    return refreshed;
  }

  return buildTokenError(
    400,
    'unsupported_grant_type',
    'atc issues authorization_code and refresh_token grants',
  );
}

interface CodeExchange {
  readonly code: string;
  readonly verifier: string;
  readonly redirectURI: string | null;
}

async function answerCodeExchange(
  ctx: HTTPServerContext,
  clientID: string,
  exchange: CodeExchange,
): Promise<Response> {
  const code = exchange.code;
  const claim = ctx.authorization.claimCode(code);

  if (claim.kind === 'reused') {
    if (claim.grantID !== null) {
      await revokeQuietly(ctx, claim.grantID);
    }

    return buildTokenError(400, 'invalid_grant', 'the authorization code was already used');
  }

  if (claim.kind === 'unknown') {
    return buildTokenError(400, 'invalid_grant', 'the authorization code is not valid');
  }

  const issued = claim.code;

  if (
    issued.clientID !== clientID ||
    issued.redirectURI !== exchange.redirectURI ||
    !verifyPKCE(exchange.verifier, issued.codeChallenge)
  ) {
    return buildTokenError(
      400,
      'invalid_grant',
      'the authorization code does not match this request',
    );
  }

  const accessToken = mintToken('atc_at_');
  const refreshToken = mintToken('atc_rt_');

  const created = await ctx.caller.sendRequest('grant.create', {
    clientID: issued.clientID,
    clientName: issued.clientName,
    scopes: issued.scopes,
    resource: issued.resource,
    accessHash: deriveTokenHash(accessToken),
    refreshHash: deriveTokenHash(refreshToken),
  });

  const grantID = String(created['grant']);

  if (ctx.authorization.updateCodeGrant(code, grantID)) {
    await revokeQuietly(ctx, grantID);

    return buildTokenError(400, 'invalid_grant', 'the authorization code was already used');
  }

  return buildTokenResponse(accessToken, refreshToken, created['expiresIn'], issued.scopes);
}

async function answerRefresh(
  ctx: HTTPServerContext,
  clientID: string,
  refreshToken: string,
): Promise<Response> {
  const accessToken = mintToken('atc_at_');
  const nextRefreshToken = mintToken('atc_rt_');

  try {
    const refreshed = await ctx.caller.sendRequest('grant.refresh', {
      refreshHash: deriveTokenHash(refreshToken),
      accessHash: deriveTokenHash(accessToken),
      nextRefreshHash: deriveTokenHash(nextRefreshToken),
      clientID,
      resource: ctx.resource,
    });

    const scopes = Array.isArray(refreshed['scopes']) ? refreshed['scopes'] : [];

    return buildTokenResponse(accessToken, nextRefreshToken, refreshed['expiresIn'], scopes);
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'unauthorized') {
      return buildTokenError(400, 'invalid_grant', error.message);
    }

    throw error;
  }
}

async function revokeQuietly(ctx: HTTPServerContext, grantID: string): Promise<void> {
  try {
    await ctx.caller.sendRequest('grant.revoke', { grant: grantID });
  } catch {
    // A grant that is already gone needs no revoking.
  }
}

function buildTokenResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: unknown,
  scopes: readonly unknown[],
): Response {
  return Response.json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: typeof expiresIn === 'number' ? expiresIn : 3600,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}

function buildTokenError(status: number, error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}
