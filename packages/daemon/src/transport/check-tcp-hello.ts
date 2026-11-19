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

  readonly build: string;
}

interface AcceptedTCPHello {
  readonly ok: true;
  readonly fingerprint: string;
  readonly principal: string | null;
  readonly viewer: string | null;
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
  // A peer without a valid token must learn nothing about the daemon, so the token check runs
  // before any parsing or other refusal.
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
  const viewer = parsedHello.data.viewer ?? null;

  if (viewer !== null && principal === null) {
    return { ok: false, code: 'bad_args', message: 'daemon.hello viewer needs a principal' };
  }

  for (const listed of [principal, viewer]) {
    if (listed !== null && !checks.hasListedPrincipal(listed)) {
      checks.tcp.recordRefusedPrincipal();

      return {
        ok: false,
        code: 'unauthorized',
        message: `principal '${listed}' is not listed in principals`,
      };
    }
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
    viewer,
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
