import { expect, test } from 'bun:test';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { planEventReads } from './plan-event-reads';

test('it starts every daemon at the start of its trail without a cursor', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(planEventReads(null, buildEventsFilterHash(null, null), null, registry)).toStrictEqual(
    new Map([
      ['cloud', { kind: 'after', cursor: null }],
      ['pc', { kind: 'after', cursor: null }],
    ]),
  );
});

test('it starts a daemon the cursor leaves out at its newest event', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash(null, null);
  const cursor = encodeGatewayCursor(filter, new Map([['cloud.0f6c2a8e', 'c-4']]));

  expect(planEventReads(cursor, filter, null, registry)).toStrictEqual(
    new Map([
      ['cloud', { kind: 'after', cursor: 'c-4' }],
      ['pc', { kind: 'newest' }],
    ]),
  );
});

test('it asks only the daemon that owns the session a read is filtered to', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash('pc.9a1b2c3d.s1', null);
  const cursor = encodeGatewayCursor(filter, new Map([['pc.9a1b2c3d', 'c-2']]));

  expect(planEventReads(cursor, filter, 'pc', registry)).toStrictEqual(
    new Map([['pc', { kind: 'after', cursor: 'c-2' }]]),
  );
});

test('it starts a daemon whose position the cursor holds as null at its latest events', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash(null, null);

  const cursor = encodeGatewayCursor(
    filter,
    new Map([
      ['cloud.0f6c2a8e', 'c-4'],
      ['pc.9a1b2c3d', null],
    ]),
  );

  expect(planEventReads(cursor, filter, null, registry)).toStrictEqual(
    new Map([
      ['cloud', { kind: 'after', cursor: 'c-4' }],
      ['pc', { kind: 'latest' }],
    ]),
  );
});
