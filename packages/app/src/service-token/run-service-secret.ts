import { mintServiceSecret } from '@atc/mcp';
import type { ProcessIO } from '../cli/process-io';

export function runServiceSecret(io: Pick<ProcessIO, 'print' | 'printError'>): void {
  const minted = mintServiceSecret();

  io.printError(
    'atc mcp service-secret: put the digest in the client\'s "secretDigests" in the service-token file, then send SIGHUP to the server. The secret is shown only now.',
  );

  io.print(`secret: ${minted.secret}`);
  io.print(`digest: ${minted.digest}`);
}
