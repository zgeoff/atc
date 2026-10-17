import { z } from 'zod';
import type { GuestOAuthState } from '../agent-adapter';

interface CodexSignIn {
  readonly idClaims: Readonly<Record<string, unknown>>;

  // Codex sends this with every request, so a sign-in without one cannot work.
  readonly accountID: string;
}

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
