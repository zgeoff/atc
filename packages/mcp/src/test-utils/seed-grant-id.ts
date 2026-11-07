import type { MCPAuthSeedDeps } from './types';

export interface GrantIDInput {
  readonly clientID: string;
  readonly grantID: string;
}

export async function seedGrantID(
  deps: Pick<MCPAuthSeedDeps, 'db'>,
  input: GrantIDInput,
): Promise<GrantIDInput> {
  // A grant with a chosen id: the OAuth provider draws each grant's id at
  // random, so no code here picks one, such as an id that starts with a dash.
  await deps.db
    .updateTable('oauthAccessToken')
    .set({ authorizationCodeId: input.grantID })
    .where('clientId', '=', input.clientID)
    .execute();

  await deps.db
    .updateTable('oauthRefreshToken')
    .set({ authorizationCodeId: input.grantID })
    .where('clientId', '=', input.clientID)
    .execute();

  return input;
}
