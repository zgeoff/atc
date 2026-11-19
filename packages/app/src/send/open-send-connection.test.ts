import { expect, test } from 'bun:test';
import { systemClock } from '@atc/core';
import { SPAWN_ANSWER_SCHEMA } from '@atcx/contract';
import { startStubAgentDaemon } from '../test-utils/start-stub-agent-daemon';
import { openSendConnection } from './open-send-connection';
import { runSend } from './run-send';
import type { SendRequest } from './types';

// Claude never starts, so it never opens a message tap and each sent message stays queued.
async function setupTest() {
  const stub = await startStubAgentDaemon({ tapGraceMs: 0 });

  stub.agents.holdStart('claude');

  const spawned = await stub.daemon.client.sendRequest('session.spawn', { cwd: stub.home });

  const session = SPAWN_ANSWER_SCHEMA.parse(spawned).session.id;

  await stub.daemon.client.sendRequest('session.update', { session, name: 'harbor' });

  const out: string[] = [];
  const err: string[] = [];

  const baseRequest: SendRequest = {
    session: 'harbor',
    text: { kind: 'literal', value: 'hello' },
    key: 'k-replay',
    wait: false,
    timeoutSeconds: 5,
    from: null,
    owner: false,
    daemon: null,
    json: false,
  };

  return {
    session,
    out,
    err,
    baseRequest,
    daemon: stub.daemon,
    send: (request: SendRequest) =>
      runSend(request, {
        connect: (target) =>
          openSendConnection(target, {
            socketPath: stub.daemon.socketPath,
            build: stub.daemon.build,
            session: undefined,
            resolveDaemon: () => ({ ok: false, message: 'no daemons in this test' }),
          }),
        readStdin: () => Promise.resolve(''),
        isStdinTTY: false,
        insideSession: false,
        mintKey: () => 'atc-send-minted',
        clock: systemClock,
        io: {
          print: (line) => {
            out.push(line);
          },
          printError: (line) => {
            err.push(line);
          },
        },
      }),
  };
}

test('it replays the first message when the same key is sent again', async () => {
  const ctx = await setupTest();
  const first = await ctx.send({ ...ctx.baseRequest, from: 'cron' });
  const second = await ctx.send({ ...ctx.baseRequest, from: 'other-name' });

  expect({ first, second, printed: ctx.out, errors: ctx.err }).toStrictEqual({
    first: 0,
    second: 0,
    printed: [expect.stringMatching(/^m-/u), expect.stringMatching(/^m-/u)],
    errors: [],
  });

  expect(ctx.out[1]).toBe(ctx.out[0] ?? '');
});

test('it labels a bare send as a local sender named after --from', async () => {
  const ctx = await setupTest();

  await ctx.send({ ...ctx.baseRequest, from: 'cron' });

  const got = await ctx.daemon.client.sendRequest('message.get', { message: ctx.out[0] });

  expect(got['sender']).toStrictEqual({ kind: 'local', name: 'cron' });
});

test('it labels a send as atc-send without --from', async () => {
  const ctx = await setupTest();

  await ctx.send(ctx.baseRequest);

  const got = await ctx.daemon.client.sendRequest('message.get', { message: ctx.out[0] });

  expect(got['sender']).toStrictEqual({ kind: 'local', name: 'atc-send' });
});

test('it labels a send as the owner under --owner', async () => {
  const ctx = await setupTest();

  await ctx.send({ ...ctx.baseRequest, owner: true });

  const got = await ctx.daemon.client.sendRequest('message.get', { message: ctx.out[0] });

  expect(got['sender']).toStrictEqual({ kind: 'owner', name: 'owner' });
});

test('it exits 3 for a name no session has', async () => {
  const ctx = await setupTest();
  const exit = await ctx.send({ ...ctx.baseRequest, session: 'nobody' });

  expect(exit).toBe(3);
});

test('it exits 3 for a name that two sessions share', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.daemon.client.sendRequest('session.spawn', { cwd: '/' });

  await ctx.daemon.client.sendRequest('session.update', {
    session: SPAWN_ANSWER_SCHEMA.parse(spawned).session.id,
    name: 'harbor',
  });

  const exit = await ctx.send(ctx.baseRequest);

  expect(exit).toBe(3);
});

test('it exits 4 when no daemon listens on the socket', async () => {
  const ctx = await setupTest();

  const exit = await runSend(ctx.baseRequest, {
    connect: (target) =>
      openSendConnection(target, {
        socketPath: '/nonexistent/atc.sock',
        build: ctx.daemon.build,
        session: undefined,
        resolveDaemon: () => ({ ok: false, message: 'none' }),
      }),
    readStdin: () => Promise.resolve(''),
    isStdinTTY: false,
    insideSession: false,
    mintKey: () => 'k',
    clock: systemClock,
    io: { print: () => {}, printError: () => {} },
  });

  expect(exit).toBe(4);
});
