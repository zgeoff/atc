import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { buildPayloadHash } from '../daemon/build-payload-hash';
import { startDaemon } from '../daemon/daemon';
import { DaemonError } from '../protocol/daemon-error';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import { getRecord } from '../shared/get-record';
import { StateStore } from '../store/state-store';
import { collectUnruledIDPaths } from './collect-unruled-id-paths';
import { ERROR_DATA_RULES, ID_RULES } from './id-rules';

/**
 * A real daemon whose sessions run `sleep`, on state at `dbPath`. `boot`
 * starts it and returns its owner's connection, so a test can seed the
 * state first. Every answer these tests check comes from it, so a field
 * the daemon starts sending with an id in it fails the check below until
 * a rule covers it.
 */
function setupTest() {
  const tmp = setupTempDir('atc-id-rules-');
  const stops: (() => Promise<void>)[] = [];

  return {
    dbPath: join(tmp.dir, 'state.db'),
    async boot(): Promise<DaemonClient> {
      const daemon = await startDaemon({
        socketPath: join(tmp.dir, 'daemon.sock'),
        reporterSocketPath: join(tmp.dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter: {
          id: 'claude',
          screenDetector: null,
          takesMessages: true,
          headlessRunner: null,
          planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
          normalizeHook: () => ({ kind: 'prompt-submitted' }),
          loadName: () => Promise.resolve(null),
          canResume: () => true,
          buildResumeCommand: () => 'claude --resume',
        },
        dbPath: join(tmp.dir, 'state.db'),
        statusPath: join(tmp.dir, 'status.json'),
      });

      const owner = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

      stops.push(async () => {
        owner.stop();

        await daemon.stop();
      });

      await owner.sendHello('atc/test-build');

      return owner;
    },
    async [Symbol.asyncDispose]() {
      for (const stop of stops) {
        await stop();
      }

      tmp[Symbol.dispose]();
    },
  };
}

test('it has a rule for every id in a session.spawn answer of a sub-session', async () => {
  await using daemon = setupTest();

  const owner = await daemon.boot();

  const parent = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
  });

  const child = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(collectUnruledIDPaths(child, ID_RULES['session.spawn'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.list answer', async () => {
  await using daemon = setupTest();

  const owner = await daemon.boot();

  const parent = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
  });

  await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  const listed = await owner.sendRequest('session.list');

  expect(collectUnruledIDPaths(listed, ID_RULES['session.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.get answer', async () => {
  await using daemon = setupTest();

  const owner = await daemon.boot();

  const spawned = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
    prompt: 'hello',
  });

  const got = await owner.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(collectUnruledIDPaths(got, ID_RULES['session.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in session.message and message.get answers', async () => {
  await using daemon = setupTest();

  const owner = await daemon.boot();

  const spawned = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
  });

  const sent = await owner.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    from: 'tester',
    text: 'ping',
    idempotencyKey: 'message-1',
  });

  const got = await owner.sendRequest('message.get', { message: sent['message'] });

  expect(collectUnruledIDPaths(sent, ID_RULES['session.message'] ?? new Map())).toStrictEqual([]);
  expect(collectUnruledIDPaths(got, ID_RULES['message.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in an events.read answer', async () => {
  await using daemon = setupTest();

  const owner = await daemon.boot();

  const spawned = await owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    resume: `a-${randomUUID()}`,
  });

  await owner.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    from: 'tester',
    text: 'ping',
  });

  const read = await waitFor(async () => {
    const page = await owner.sendRequest('events.read', {});

    expect(page['events']).not.toBeEmpty();

    return page;
  });

  expect(collectUnruledIDPaths(read, ID_RULES['events.read'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in the data of an uncertain keyed spawn', async () => {
  await using daemon = setupTest();

  const params = { cwd: '/tmp', resume: 'a-1', idempotencyKey: 'spawn-1' };

  const seed = await StateStore.open(daemon.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.spawn',
    key: 'spawn-1',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.spawn'].parse(params)),
    effectRef: randomUUID(),
    at: Date.now(),
  });

  await seed.stop();

  const owner = await daemon.boot();

  const refused = await owner.sendRequest('session.spawn', params).then(
    () => null,
    (error: unknown) => error,
  );

  if (!(refused instanceof DaemonError)) {
    throw new Error('the uncertain spawn was not refused');
  }

  expect(refused.code).toBe('outcome_unknown');
  expect(refused.data).toContainKey('effectRef');
  expect(collectUnruledIDPaths(refused.data, ERROR_DATA_RULES)).toStrictEqual([]);
});

test('it finds an id in a field no rule covers', () => {
  const answer = {
    sessions: [
      {
        id: '2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
        origin: 'm-0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
        locator: { daemonID: '9a1b2c3d-0000-4000-8000-000000000001', targetID: 'local' },
      },
    ],
  };

  expect(collectUnruledIDPaths(answer, ID_RULES['session.list'] ?? new Map())).toStrictEqual([
    'sessions[].origin',
  ]);
});
