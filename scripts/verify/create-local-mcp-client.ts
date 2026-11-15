import { mintServiceSecret } from '@atc/mcp';
import { localMCPClient } from './constants.ts';

// Mints the run's service client and returns its secret's digest. The mcp driver reads the secret
// from the supervisor's environment, which the supervisor copied for the app before it called
// `launch`, so the secret never reaches the app.
export function createLocalMCPClient(): string {
  const minted = mintServiceSecret();

  process.env[localMCPClient.secretEnv] = minted.secret;

  return minted.digest;
}
