import { z } from 'zod';
import type { GuestOAuthState } from '../agent-adapter';

/**
 * The ChatGPT sign-in a Codex CLI on a remote host signs in with, read
 * from the state impd lists for its `oauth` secret: the ID token's claims
 * and the ChatGPT account id among them. Codex sends that account id with
 * every request, so a sign-in without one cannot work.
 */
interface CodexSignIn {
  readonly idClaims: Readonly<Record<string, unknown>>;
  readonly accountID: string;
}

/**
 * The sign-in a ready `oauth` secret gives Codex, or null when the secret
 * is not listed, not ready, or holds an ID token with no ChatGPT account
 * id.
 */
export function findCodexSignIn(state: GuestOAuthState | undefined): CodexSignIn | null {
  if (state?.status !== 'ready' || state.idClaims === null) {
    return null;
  }

  const claims = ID_CLAIMS_SCHEMA.safeParse(state.idClaims);

  if (!claims.success) {
    return null;
  }

  return {
    idClaims: state.idClaims,
    accountID: claims.data[OPENAI_AUTH_CLAIM].chatgpt_account_id,
  };
}

// The ID token claim that holds the ChatGPT account and plan.
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

// The ID token claims that hold a ChatGPT account id.
const ID_CLAIMS_SCHEMA = z.object({
  [OPENAI_AUTH_CLAIM]: z.object({ chatgpt_account_id: z.string().min(1) }),
});
