import { expect, mock, test } from 'bun:test';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { toSessionID } from '@atcx/contract';
import { checkTCPHello } from './check-tcp-hello';
import type { TCPPeer } from './tcp-peer';

// A listener stand-in that matches one token, `t-good`, to the
// fingerprint `fp-1`, and a principal list that holds `ci` alone.
function setupTest() {
  const verifyHandshake = mock<TCPPeer['verifyHandshake']>((presented) => {
    const fingerprint = presented === 't-good' ? 'fp-1' : null;

    return Promise.resolve(fingerprint);
  });

  const recordRefusedPrincipal = mock<TCPPeer['recordRefusedPrincipal']>();

  const checks = {
    tcp: { verifyHandshake, recordRefusedPrincipal },
    hasListedPrincipal: (principal: string) => principal === 'ci',
    build: '1.2.3',
  };

  return { verifyHandshake, recordRefusedPrincipal, checks };
}

test('it accepts a handshake with a held token and a listed principal', async () => {
  const ctx = setupTest();

  const hello = await checkTCPHello(
    {
      version: PROTOCOL_V,
      id: 1,
      method: 'daemon.hello',
      params: {
        client: 'remote-tui',
        principal: 'ci',
        session: 's-1',
        auth: { scheme: 'bearer', token: 't-good' },
      },
    },
    ctx.checks,
  );

  expect(hello).toStrictEqual({
    ok: true,
    fingerprint: 'fp-1',
    principal: 'ci',
    session: toSessionID('s-1'),
    client: 'remote-tui',
  });
});

test('it refuses a handshake whose token the listener does not hold', async () => {
  const ctx = setupTest();

  const hello = await checkTCPHello(
    {
      version: PROTOCOL_V,
      id: 1,
      method: 'daemon.hello',
      params: { client: 'remote-tui', auth: { scheme: 'bearer', token: 't-wrong' } },
    },
    ctx.checks,
  );

  expect(hello).toStrictEqual({
    ok: false,
    code: 'unauthorized',
    message: 'daemon.hello over TCP needs a valid bearer token',
  });
});

test('it checks no token for a handshake whose auth is not a bearer token', async () => {
  const ctx = setupTest();

  await checkTCPHello(
    {
      version: PROTOCOL_V,
      id: 1,
      method: 'daemon.hello',
      params: { client: 'remote-tui', auth: { scheme: 'basic', token: 't-good' } },
    },
    ctx.checks,
  );

  expect(ctx.verifyHandshake).toHaveBeenCalledExactlyOnceWith(null);
});

test('it refuses a principal the config does not list and records the refusal', async () => {
  const ctx = setupTest();

  const hello = await checkTCPHello(
    {
      version: PROTOCOL_V,
      id: 1,
      method: 'daemon.hello',
      params: {
        client: 'remote-tui',
        principal: 'guest',
        auth: { scheme: 'bearer', token: 't-good' },
      },
    },
    ctx.checks,
  );

  expect(hello).toStrictEqual({
    ok: false,
    code: 'unauthorized',
    message: "principal 'guest' is not listed in principals",
  });

  expect(ctx.recordRefusedPrincipal).toHaveBeenCalledOnce();
});

test('it refuses a handshake whose fields do not parse', async () => {
  const ctx = setupTest();

  const hello = await checkTCPHello(
    {
      version: PROTOCOL_V,
      id: 1,
      method: 'daemon.hello',
      params: { client: 'remote-tui', principal: '', auth: { scheme: 'bearer', token: 't-good' } },
    },
    ctx.checks,
  );

  expect(hello).toMatchObject({ ok: false, code: 'bad_args' });
});

test('it refuses a handshake on another protocol version', async () => {
  const ctx = setupTest();

  const hello = await checkTCPHello(
    {
      version: PROTOCOL_V + 1,
      id: 1,
      method: 'daemon.hello',
      params: { client: 'remote-tui', auth: { scheme: 'bearer', token: 't-good' } },
    },
    ctx.checks,
  );

  expect(hello).toMatchObject({ ok: false, code: 'protocol_mismatch' });
});
