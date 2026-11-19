import { PROTOCOL_V } from '@atc/protocol/wire';
import type { MismatchRefusalData } from '@atcx/contract';
import { CONTRACT_MAJOR } from '@atcx/contract/light';

interface MajorRefusal {
  readonly code: 'protocol_mismatch';
  readonly message: string;
  readonly data: MismatchRefusalData;
}

// Reads the raw params, so an older client that sends a field the strict schema lacks still gets
// protocol_mismatch and never bad_args.
export function checkHelloMajor(
  params: Readonly<Record<string, unknown>>,
  build: string,
): MajorRefusal | null {
  const major = params['major'];

  if (major === CONTRACT_MAJOR) {
    return null;
  }

  const client = typeof params['client'] === 'string' ? params['client'] : 'unknown client';
  const protocol = params['protocol'];
  const clientMajor = typeof major === 'number' ? major : null;
  const isClientOlder = clientMajor === null || clientMajor < CONTRACT_MAJOR;

  return {
    code: 'protocol_mismatch',
    message: `${client} is on major version ${clientMajor ?? 'unknown'} and protocol v${typeof protocol === 'number' ? protocol : 'unknown'}, daemon ${build} speaks v${PROTOCOL_V} on major version ${CONTRACT_MAJOR}; ${isClientOlder ? 'update or reopen the client' : 'restart the daemon'} so both run the same major version`,
    data: { daemonProtocol: PROTOCOL_V, daemonMajor: CONTRACT_MAJOR },
  };
}
