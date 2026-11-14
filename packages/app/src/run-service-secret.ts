import { mintServiceSecret } from '@atc/mcp';
import type { ProcessIO } from './process-io';

// Prints a new secret once, with the digest that goes in the service-token
// file. The secret goes to stdout only, and no file holds it.
export function runServiceSecret(io: Pick<ProcessIO, 'print' | 'printError'>): void {
  const minted = mintServiceSecret();

  io.printError(
    'atc mcp service-secret: put the digest in the client\'s "secretDigests" in the service-token file, then send SIGHUP to the server. The secret is shown only now.',
  );

  io.print(`secret: ${minted.secret}`);
  io.print(`digest: ${minted.digest}`);
}
