import { mintServiceSecret } from '@atc/mcp';
import { localMCPClient } from './constants.ts';

// The mcp driver reads the secret from the supervisor's environment, which the supervisor copied for the app before launch, so the secret never reaches the app.
export function createLocalMCPClient(): string {
  const minted = mintServiceSecret();

  process.env[localMCPClient.secretEnv] = minted.secret;

  return minted.digest;
}
