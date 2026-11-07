import invariant from 'tiny-invariant';
import { createEnrollmentToken } from '../auth/create-enrollment-token';
import { createPasskey } from '../auth/create-passkey';
import type { NewPasskey } from '../auth/create-passkey';
import { deriveTokenHash } from '../auth/derive-token-hash';
import { buildMockNewPasskey } from './build-mock-new-passkey';
import type { MCPAuthSeedDeps } from './types';

export type PasskeyInput = Partial<Omit<NewPasskey, 'tokenHash'>>;

export async function seedPasskey(
  deps: MCPAuthSeedDeps,
  input: PasskeyInput = {},
): Promise<NewPasskey> {
  const now = input.now ?? deps.clock.now();

  const enrollment = await createEnrollmentToken(deps.db, now);

  const passkey = buildMockNewPasskey({
    ...input,
    now,
    tokenHash: deriveTokenHash(enrollment.token),
  });

  const created = await createPasskey(deps.db, passkey);

  invariant(created);

  return passkey;
}
