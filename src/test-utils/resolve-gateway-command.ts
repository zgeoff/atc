import { join } from 'node:path';

/**
 * The command a test runs `atc-gateway` as: the compiled binary at the given
 * path, which a smoke run of a release build passes in through
 * `ATC_GATEWAY_BIN`, or without one the source entry under the test's own
 * bun, so one gateway suite proves both.
 */
export function resolveGatewayCommand(binary: string | undefined): readonly string[] {
  return binary === undefined
    ? [process.execPath, join(import.meta.dir, '..', 'gateway.ts')]
    : [binary];
}
