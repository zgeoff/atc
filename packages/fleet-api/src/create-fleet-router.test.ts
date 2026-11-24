import { expect, test } from 'bun:test';
import { buildMockSessionDescriptor } from '@atc/protocol/test-utils/build-mock-session-descriptor';
import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { createRouterClient } from '@orpc/server';
import { createFleetRouter } from './create-fleet-router';
import { buildMockGatewayDescriptor } from './test-utils/build-mock-gateway-descriptor';
import { buildStubFleetCaller } from './test-utils/build-stub-fleet-caller';

type Answer = NonNullable<NonNullable<Parameters<typeof buildStubFleetCaller>[0]>['answer']>;

function setupTest(answer: Answer = () => ({})) {
  const caller = buildStubFleetCaller({ answer });
  const gateway = createFleetRouter({ caller, contract: FLEET_CONTRACT });
  const local = createFleetRouter({ caller, contract: LOCAL_FLEET_CONTRACT });
  const principal = { id: 'service:nixie', name: 'nixie' };
  const all: GrantScope[] = ['read', 'message', 'spawn', 'kill'];

  return {
    caller,
    principal,
    all,
    asGateway: (scopes: GrantScope[], withPrincipal = true) =>
      createRouterClient(gateway, {
        context: { principal: withPrincipal ? principal : null, scopes },
      }),
    asLocal: (scopes: GrantScope[]) =>
      createRouterClient(local, { context: { principal: null, scopes } }),
  };
}

test('it refuses a read procedure to a caller without the read scope', async () => {
  const ctx = setupTest();

  await expect(ctx.asGateway(['message']).session.list({})).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['read'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses a message procedure to a caller without the message scope', async () => {
  const ctx = setupTest();

  const call = ctx.asGateway(['read', 'spawn', 'kill']).session.message({
    session: 'build-box.k3f9.s7-m4x2p',
    text: 'hi',
    idempotencyKey: 'job-1',
  });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['message'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses a spawn procedure to a caller without the spawn scope', async () => {
  const ctx = setupTest();

  const call = ctx
    .asGateway(['read', 'message', 'kill'])
    .session.spawn({ cwd: '/work', idempotencyKey: 'job-1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['spawn'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses a kill procedure to a caller without the kill scope', async () => {
  const ctx = setupTest();
  const call = ctx.asGateway(['read', 'message', 'spawn']).session.kill({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['kill'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses a menu read to a caller with only the read scope', async () => {
  const ctx = setupTest();
  const call = ctx.asGateway(['read']).session.menu({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['spawn'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it answers a note read for a caller with the read scope alone', async () => {
  const note = {
    note: 'a.b.n1',
    at: 1,
    session: 'a.b.s1',
    name: null,
    label: 'x',
    text: 't',
    complete: true,
  };

  const ctx = setupTest(() => note);

  const answer = await ctx.asGateway(['read']).note.get({ note: 'a.b.n1' });

  expect(answer).toStrictEqual(note);
});

test('it refuses a note read to a caller without the read scope', async () => {
  const ctx = setupTest();

  await expect(
    ctx.asGateway(['message', 'spawn']).note.get({ note: 'a.b.n1' }),
  ).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['read'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses an owner-only procedure to a caller with a principal', async () => {
  const ctx = setupTest();
  const call = ctx.asGateway(ctx.all).session.auth.rebind({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({ code: 'unauthorized' });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it sends an owner-only procedure for a caller with no principal', async () => {
  const ctx = setupTest(() => ({ revision: 2, restartPending: [] }));

  const answer = await ctx.asLocal(ctx.all).session.auth.rebind({ session: 's1' });

  expect(answer).toStrictEqual({ revision: 2, restartPending: [] });
});

test('it refuses a spawn that grants an atcAccess scope the caller lacks', async () => {
  const ctx = setupTest();

  const call = ctx.asGateway(['spawn', 'read']).session.spawn({
    cwd: '/work',
    atcAccess: ['read', 'kill', 'message'],
    idempotencyKey: 'job-1',
  });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['kill', 'message'] },
  });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it sends a spawn that grants only scopes the caller holds, with the fixed terminal size', async () => {
  const ctx = setupTest(() => ({ session: buildMockSessionDescriptor() }));

  await ctx
    .asLocal(['spawn', 'read'])
    .session.spawn({ cwd: '/work', atcAccess: ['read'], idempotencyKey: 'job-1' });

  expect(ctx.caller.requests).toStrictEqual([
    {
      method: 'session.spawn',
      params: {
        cwd: '/work',
        name: '',
        prompt: '',
        atcAccess: ['read'],
        idempotencyKey: 'job-1',
        cols: 100,
        rows: 30,
      },
    },
  ]);
});

test('it sends a kill that stops the session and keeps its record', async () => {
  const ctx = setupTest(() => ({ stopped: true }));

  await ctx.asGateway(ctx.all).session.kill({ session: 'a.b.s1' });

  expect(ctx.caller.requests).toStrictEqual([
    {
      method: 'session.kill',
      params: { session: 'a.b.s1', stopOnly: true },
      principal: ctx.principal,
    },
  ]);
});

test('it sends a forget that refuses a pinned or live session', async () => {
  const ctx = setupTest(() => ({ confirmToken: 't', expiresAt: 1 }));

  await ctx.asGateway(ctx.all).session.forget({ session: 'a.b.s1' });

  expect(ctx.caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    refusePinned: true,
    refuseLive: true,
  });
});

test('it sends a forget that stops a live session when the caller asks to stop', async () => {
  const ctx = setupTest(() => ({ confirmToken: 't', expiresAt: 1 }));

  await ctx.asGateway(ctx.all).session.forget({ session: 'a.b.s1', stop: true });

  expect(ctx.caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    refusePinned: true,
    refuseLive: false,
  });
});

test('it sends an adopt with the fixed terminal size', async () => {
  const ctx = setupTest(() => ({}));

  await ctx.asGateway(ctx.all).session.adopt({ session: 'a.b.s1' });

  expect(ctx.caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    cols: 100,
    rows: 30,
  });
});

test('it sends the caller a null principal as no principal', async () => {
  const ctx = setupTest(() => ({}));

  await ctx.asLocal(ctx.all).session.ack({ session: 's1' });

  expect(ctx.caller.requests).toStrictEqual([{ method: 'session.ack', params: { session: 's1' } }]);
});

test('it refuses an input its schema rejects as bad_args and sends nothing', async () => {
  const ctx = setupTest();

  const call = ctx
    .asGateway(ctx.all)
    .session.message({ session: 'a.b.s1', text: '', idempotencyKey: 'job-1' });

  await expect(call).rejects.toMatchObject({ code: 'bad_args' });

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it turns an answer that fails its output check into internal', async () => {
  const ctx = setupTest(() => ({ stopped: 'yes' }));

  await expect(ctx.asGateway(ctx.all).session.kill({ session: 'a.b.s1' })).rejects.toMatchObject({
    code: 'internal',
  });
});

test('it returns an answer with a field the contract does not declare', async () => {
  const answer = { text: 'ready', cols: 80, rows: 24, scrollback: 500 };
  const ctx = setupTest(() => answer);

  const result = await ctx.asGateway(ctx.all).session.screen({ session: 'a.b.s1' });

  expect(result).toStrictEqual(answer);
});

test('it returns a session list from a newer daemon with a state the contract does not list', async () => {
  const session = { ...buildMockGatewayDescriptor(), state: 'paused' };
  const answer = { sessions: [session], daemons: [{ name: 'build-box', state: 'frozen' }] };
  const ctx = setupTest(() => answer);

  const result = await ctx.asGateway(ctx.all).session.list({});

  expect(result).toStrictEqual(answer);
});

test('it returns a session list from an older daemon that leaves out the optional fields', async () => {
  const session = buildMockGatewayDescriptor();
  const answer = { sessions: [session], daemons: [{ name: 'build-box', state: 'up' }] };
  const ctx = setupTest(() => answer);

  const result = await ctx.asGateway(ctx.all).session.list({});

  expect(result).toStrictEqual(answer);
});

test('it checks a local answer against the local contract, which has no daemons list', async () => {
  const answer = { sessions: [buildMockSessionDescriptor()] };
  const ctx = setupTest(() => answer);

  const [local, gateway] = await Promise.allSettled([
    ctx.asLocal(ctx.all).session.list({}),
    ctx.asGateway(ctx.all).session.list({}),
  ]);

  expect([local.status, gateway.status]).toStrictEqual(['fulfilled', 'rejected']);
});

test('it keeps the code, message and data of an AtcError from the caller', async () => {
  const ctx = setupTest(() => {
    throw new AtcError('no_such_session', "no session 's9'", { session: 's9' });
  });

  const call = ctx.asGateway(ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'no_such_session',
    message: "no session 's9'",
    data: { session: 's9' },
  });
});

test('it keeps the code, message and data of a gateway error that is no AtcError', async () => {
  const ctx = setupTest(() => {
    throw Object.assign(new Error('daemon build-box is down'), {
      code: 'daemon_unavailable',
      data: { reason: 'daemon_changed' },
    });
  });

  const call = ctx.asGateway(ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: 'daemon build-box is down',
    data: { reason: 'daemon_changed' },
  });
});

test('it keeps an error code outside the fleet error map', async () => {
  const ctx = setupTest(() => {
    throw Object.assign(new Error('the connection dropped'), { code: 'connection_lost' });
  });

  const call = ctx.asGateway(ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'connection_lost',
    message: 'the connection dropped',
  });
});

test('it turns an error with no code into internal', async () => {
  const ctx = setupTest(() => {
    throw new Error('boom');
  });

  const call = ctx.asGateway(ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'internal', message: 'boom' });
});
