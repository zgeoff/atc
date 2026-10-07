import { expect, test } from 'bun:test';
import { encodeCursor } from '../protocol/encode-cursor';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';

test('it decodes the worst-case events cursor of 34 daemons with the longest names', () => {
  const daemons = Array.from({ length: 34 }, (_, i) => ({
    name: `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
    address: { host: '100.64.0.2', port: 8415 },
    daemonID: `${String(i).padStart(8, 'f')}-0000-4000-8000-000000000000`,
    incarnation: String(i).padStart(8, 'f'),
    token: 't',
  }));

  const registry = {
    daemons: new Map(daemons.map((daemon) => [daemon.name, daemon])),
    defaultDaemon: `${'d'.repeat(29)}00`,
  };

  const filter = buildEventsFilterHash('x'.repeat(200), null);
  const worst = encodeCursor({ kind: 'events', id: Number.MAX_SAFE_INTEGER });

  const cursor = encodeGatewayCursor(
    filter,
    new Map(daemons.map((daemon) => [`${daemon.name}.${daemon.incarnation}`, worst])),
  );

  expect(decodeGatewayCursor(cursor, filter, registry)).toStrictEqual(
    new Map(daemons.map((daemon) => [daemon.name, worst])),
  );
});

test('it refuses the worst-case events cursor of 35 daemons with the longest names as too long', () => {
  const daemons = Array.from({ length: 35 }, (_, i) => ({
    name: `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
    address: { host: '100.64.0.2', port: 8415 },
    daemonID: `${String(i).padStart(8, 'f')}-0000-4000-8000-000000000000`,
    incarnation: String(i).padStart(8, 'f'),
    token: 't',
  }));

  const registry = {
    daemons: new Map(daemons.map((daemon) => [daemon.name, daemon])),
    defaultDaemon: `${'d'.repeat(29)}00`,
  };

  const filter = buildEventsFilterHash('x'.repeat(200), null);
  const worst = encodeCursor({ kind: 'events', id: Number.MAX_SAFE_INTEGER });

  const cursor = encodeGatewayCursor(
    filter,
    new Map(daemons.map((daemon) => [`${daemon.name}.${daemon.incarnation}`, worst])),
  );

  expect(() => decodeGatewayCursor(cursor, filter, registry)).toThrow(
    expect.objectContaining({ code: 'bad_args', message: 'cursor exceeds 4096 bytes' }),
  );
});
