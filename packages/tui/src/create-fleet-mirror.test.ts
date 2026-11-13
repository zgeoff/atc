import { expect, test } from 'bun:test';
import { buildMockSessionDescriptor } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createFleetMirror } from './create-fleet-mirror';
import { buildMockMirrorSession } from './testing/build-mock-mirror-session';
import { buildStubRequestClient } from './testing/build-stub-request-client';

test('it holds two rows for one session id on two daemons, and finds each by its key', () => {
  const mirror = createFleetMirror(null);

  mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', name: 'on the laptop' }));
  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', name: 'on the box' }));

  expect([
    mirror.sessions.length,
    mirror.find({ daemon: null, id: 's-1' })?.name,
    mirror.find({ daemon: 'box', id: 's-1' })?.name,
    mirror.find({ daemon: 'lab', id: 's-1' }),
  ]).toStrictEqual([2, 'on the laptop', 'on the box', undefined]);
});

test('it updates only the row of the daemon an upsert names', () => {
  const mirror = createFleetMirror(null);

  mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', state: 'running' }));
  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', state: 'running' }));
  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', state: 'needs_you' }));

  expect([
    mirror.find({ daemon: null, id: 's-1' })?.state,
    mirror.find({ daemon: 'box', id: 's-1' })?.state,
  ]).toStrictEqual(['running', 'needs_you']);
});

test("it replaces one daemon's rows on a refresh and leaves the other daemon's rows", async () => {
  const mirror = createFleetMirror(null);

  mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-local' }));
  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-old' }));

  const descriptor = buildMockSessionDescriptor({ id: toSessionID('s-new') });

  await mirror.refresh(
    'box',
    buildStubRequestClient({ 'session.list': { sessions: [descriptor] } }),
  );

  expect(mirror.sessions.map((session) => [session.daemon, session.id])).toStrictEqual([
    [null, 's-local'],
    ['box', 's-new'],
  ]);
});

test('it deletes the done time of each session a refreshed daemon no longer holds', async () => {
  const mirror = createFleetMirror(null);

  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1' }));
  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-2' }));
  mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  mirror.doneAt.set({ daemon: 'box', id: 's-1' }, 100);
  mirror.doneAt.set({ daemon: 'box', id: 's-2' }, 200);
  mirror.doneAt.set({ daemon: null, id: 's-1' }, 300);

  const descriptor = buildMockSessionDescriptor({ id: toSessionID('s-2') });

  await mirror.refresh(
    'box',
    buildStubRequestClient({ 'session.list': { sessions: [descriptor] } }),
  );

  expect([
    mirror.doneAt.get({ daemon: 'box', id: 's-1' }),
    mirror.doneAt.get({ daemon: 'box', id: 's-2' }),
    mirror.doneAt.get({ daemon: null, id: 's-1' }),
  ]).toStrictEqual([undefined, 200, 300]);
});

test('it counts the stored fleet of the primary daemon only', async () => {
  const mirror = createFleetMirror(null);

  const remote = buildStubRequestClient({
    'session.list': { sessions: [] },
    'fleet.list': { fleet: [{}] },
  });

  await mirror.refresh('box', remote);

  const local = buildStubRequestClient({
    'session.list': { sessions: [] },
    'fleet.list': { fleet: [{}, {}] },
  });

  await mirror.refresh(null, local);

  expect({ count: mirror.count, remoteAsked: remote.asked }).toStrictEqual({
    count: 2,
    remoteAsked: ['session.list'],
  });
});

test('it keeps the rows of a daemon whose list request fails', () => {
  const mirror = createFleetMirror(null);

  mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1' }));

  const refusing = buildStubRequestClient({}, new Error('the connection dropped'));

  expect(mirror.refresh('box', refusing)).rejects.toThrow('the connection dropped');
  expect(mirror.find({ daemon: 'box', id: 's-1' })).toBeDefined();
});
