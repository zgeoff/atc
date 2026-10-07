import { expect, test } from 'bun:test';
import { encodeCursor } from '../protocol/encode-cursor';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { MAX_REGISTRY_DAEMONS } from './max-registry-daemons';

test('it lets a registry list 34 daemons', () => {
  expect(MAX_REGISTRY_DAEMONS).toBe(34);
});

test('it decodes the worst-case events cursor of the most daemons a registry lists, each with the longest name', () => {
  const daemons = Array.from({ length: MAX_REGISTRY_DAEMONS }, (_, i) =>
    buildMockRegistryDaemon({
      name: `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
      incarnation: String(i).padStart(8, 'f'),
    }),
  );

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

test('it refuses the worst-case events cursor of one daemon more than a registry lists as too long', () => {
  const daemons = Array.from({ length: MAX_REGISTRY_DAEMONS + 1 }, (_, i) =>
    buildMockRegistryDaemon({
      name: `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
      incarnation: String(i).padStart(8, 'f'),
    }),
  );

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
