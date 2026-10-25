import { isRecord } from '@atc/core';
import { parseRequestParams } from '@atc/protocol';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { RequestMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { ErrorCode } from '@atcx/contract/light';
import type { TCPPeer } from './tcp-peer';

interface TCPHelloChecks {
  readonly tcp: Pick<TCPPeer, 'verifyHandshake' | 'recordRefusedPrincipal'>;
  readonly hasListedPrincipal: (principal: string) => boolean;

  // The daemon's build, which a protocol mismatch names.
  readonly build: string;
}

// A TCP handshake that passed: the fingerprint of the token it presented,
// the principal and session it gives, and its client's name.
interface AcceptedTCPHello {
  readonly ok: true;
  readonly fingerprint: string;
  readonly principal: string | null;
  readonly session: SessionID | null;
  readonly client: string;
}

interface RefusedTCPHello {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
}

export async function checkTCPHello(
  req: RequestMsg,
  checks: TCPHelloChecks,
): Promise<AcceptedTCPHello | RefusedTCPHello> {
  // the token is checked before anything else, so a peer without one learns nothing about
  // the daemon
  const fingerprint = await checks.tcp.verifyHandshake(findBearerToken(req.params));

  if (fingerprint === null) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'daemon.hello over TCP needs a valid bearer token',
    };
  }

  const parsedHello = parseRequestParams('daemon.hello', req.params);

  if (!parsedHello.ok) {
    return { ok: false, code: 'bad_args', message: parsedHello.message };
  }

  const principal = parsedHello.data.principal ?? null;

  if (principal !== null && !checks.hasListedPrincipal(principal)) {
    checks.tcp.recordRefusedPrincipal();

    return {
      ok: false,
      code: 'unauthorized',
      message: `principal '${principal}' is not listed in principals`,
    };
  }

  if (req.version !== PROTOCOL_V) {
    return {
      ok: false,
      code: 'protocol_mismatch',
      message: `${parsedHello.data.client} speaks protocol v${req.version}, daemon ${checks.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
    };
  }

  return {
    ok: true,
    fingerprint,
    principal,
    session: parsedHello.data.session ?? null,
    client: parsedHello.data.client,
  };
}

function findBearerToken(params: Readonly<Record<string, unknown>> | undefined): string | null {
  const auth = params?.['auth'];

  if (!isRecord(auth) || auth['scheme'] !== 'bearer' || typeof auth['token'] !== 'string') {
    return null;
  }

  return auth['token'];
}
