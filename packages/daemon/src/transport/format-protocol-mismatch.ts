import { PROTOCOL_V } from '@atc/protocol/wire';

export function formatProtocolMismatch(
  build: string,
  client: string,
  protocol: number | undefined,
): string {
  const remedy =
    protocol !== undefined && protocol < PROTOCOL_V
      ? 'update or reopen the client'
      : 'restart the daemon';

  return `${client} speaks protocol v${protocol ?? 'unknown'}, daemon ${build} speaks v${PROTOCOL_V}; ${remedy} so both run the same build`;
}
