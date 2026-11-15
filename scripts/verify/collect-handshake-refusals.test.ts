import { expect, test } from 'bun:test';
import { collectHandshakeRefusals } from './collect-handshake-refusals.ts';

test('it gives the peer and reason of each refused handshake, in order, and leaves out other lines', () => {
  const lines = [
    'atc tcp event=listening host=127.0.0.1 port=41877',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
    'atc tcp event=principal_refused peer=127.0.0.1 principal=unlisted count=1',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=missing_token count=2',
  ];

  expect(collectHandshakeRefusals(lines)).toStrictEqual([
    { peer: '127.0.0.1', reason: 'unauthorized' },
    { peer: '127.0.0.1', reason: 'missing_token' },
  ]);
});
