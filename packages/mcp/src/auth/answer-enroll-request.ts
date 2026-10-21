import { buildPageResponse } from '../http/build-page-response';
import { createPasskey } from './create-passkey';
import { PASSKEY_SCRIPT } from './passkey-script';
import { readEnrollmentToken } from './read-enrollment-token';
import { renderEnrollPage } from './render-enroll-page';
import type { HTTPServerContext, Requester } from './types';
import { verifyPasskeyRegistration } from './verify-passkey-registration';

export async function answerEnrollRequest(
  ctx: HTTPServerContext,
  method: 'GET' | 'POST',
  url: URL,
  body: string,
  requester: Requester,
): Promise<Response> {
  if (method === 'GET') {
    return buildPageResponse(200, { page: renderEnrollPage({ ceremony: null, error: null }) });
  }

  const form = new URLSearchParams(body);

  const token = (form.get('token') ?? '').trim();
  const context = { path: url.pathname, requester };

  const tokenHash =
    token === '' ? null : await readEnrollmentToken(ctx.store.db, token, ctx.clock.now());

  if (tokenHash === null) {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'invalid_token',
      ...context,
    });

    return buildPageResponse(400, {
      page: renderEnrollPage({
        ceremony: null,
        error:
          'That enrollment token is unknown, used, or expired. Run the enroll command on the host again for a new one.',
      }),
    });
  }

  if (!form.has('credential')) {
    return answerCeremony(ctx, 200, token, tokenHash, null);
  }

  const taken = ctx.enrollments.claimChallenge(tokenHash);

  const registered =
    taken.kind === 'taken'
      ? await verifyPasskeyRegistration({
          credential: form.get('credential') ?? '',
          challenge: taken.challenge,
          origin: ctx.origin,
          rpID: new URL(ctx.origin).hostname,
        })
      : null;

  if (registered === null) {
    const expired = taken.kind === 'expired';

    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: expired ? 'expired' : 'assertion_failed',
      ...context,
    });

    const error = expired
      ? 'The enrollment took too long. Try again.'
      : 'atc could not enroll that passkey. Try again.';

    return answerCeremony(ctx, 400, token, tokenHash, error);
  }

  let created: boolean;

  try {
    created = await createPasskey(ctx.store.db, {
      tokenHash,
      id: registered.id,
      publicKey: Buffer.from(registered.publicKey).toString('base64url'),
      counter: registered.counter,
      transports: registered.transports,
      now: ctx.clock.now(),
    });
  } catch {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'assertion_failed',
      ...context,
    });

    return answerCeremony(
      ctx,
      400,
      token,
      tokenHash,
      'That passkey is already enrolled. Use another device, or sign in with it.',
    );
  }

  if (!created) {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'invalid_token',
      ...context,
    });

    return buildPageResponse(400, {
      page: renderEnrollPage({
        ceremony: null,
        error:
          'That enrollment token is unknown, used, or expired. Run the enroll command on the host again for a new one.',
      }),
    });
  }

  ctx.security.record({ kind: 'owner_auth', outcome: 'succeeded', ...context });

  return buildPageResponse(200, {
    message: 'Passkey enrolled. Start the connection again from your client and sign in with it.',
  });
}

// How long the browser's passkey prompt waits, in milliseconds.
const PROMPT_TIMEOUT_MS = 120_000;

// The single owner's WebAuthn user handle, the same for every passkey, so
// an authenticator files each one under the one atc account.
const OWNER_HANDLE = Buffer.from('atc-owner').toString('base64url');

async function answerCeremony(
  ctx: HTTPServerContext,
  status: number,
  token: string,
  tokenHash: string,
  error: string | null,
): Promise<Response> {
  const enrolled = await ctx.store.db.selectFrom('atc_passkey').select('id').execute();

  const options = {
    challenge: ctx.enrollments.mintChallenge(tokenHash),
    rp: { id: new URL(ctx.origin).hostname, name: 'atc' },
    user: { id: OWNER_HANDLE, name: 'owner', displayName: 'atc owner' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -8 },
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: PROMPT_TIMEOUT_MS,

    // an authenticator that already holds an enrolled passkey refuses to make a second.
    excludeCredentials: enrolled.map((row) => ({ type: 'public-key', id: row.id })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
  };

  return buildPageResponse(
    status,
    { page: renderEnrollPage({ ceremony: { token, options }, error }) },
    [],
    [PASSKEY_SCRIPT.policySource],
  );
}
