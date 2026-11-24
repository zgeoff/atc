import { expect, test } from 'bun:test';
import { buildMockSessionDescriptor } from '@atc/protocol/test-utils/build-mock-session-descriptor';
import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import {
  ORPCError,
  ValidationError,
  createRouterClient,
  traverseContractProcedures,
} from '@orpc/server';
import { createFleetRouter } from './create-fleet-router';
import { buildMockGatewayDescriptor } from './test-utils/build-mock-gateway-descriptor';
import { buildStubFleetCaller } from './test-utils/build-stub-fleet-caller';
import type { FleetCaller } from './types';

function setupTest() {
  const principal = { id: 'service:ci-runner', name: 'ci-runner' };
  const all: GrantScope[] = ['read', 'message', 'spawn', 'kill'];

  return {
    principal,
    all,
    createGatewayRouter: (caller: FleetCaller) =>
      createFleetRouter({ caller, contract: FLEET_CONTRACT }),
    asGateway: (caller: FleetCaller, scopes: GrantScope[]) =>
      createRouterClient(createFleetRouter({ caller, contract: FLEET_CONTRACT }), {
        context: { principal, scopes },
      }),
    asLocal: (caller: FleetCaller, scopes: GrantScope[]) =>
      createRouterClient(createFleetRouter({ caller, contract: LOCAL_FLEET_CONTRACT }), {
        context: { principal: null, scopes },
      }),
  };
}

test('it refuses a read procedure to a caller without the read scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  await expect(ctx.asGateway(caller, ['message']).session.list({})).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['read'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a message procedure to a caller without the message scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  const call = ctx.asGateway(caller, ['read', 'spawn', 'kill']).session.message({
    session: 'build-box.k3f9.s7-m4x2p',
    text: 'hi',
    idempotencyKey: 'job-1',
  });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['message'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a spawn procedure to a caller without the spawn scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  const call = ctx
    .asGateway(caller, ['read', 'message', 'kill'])
    .session.spawn({ cwd: '/work', idempotencyKey: 'job-1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['spawn'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a kill procedure to a caller without the kill scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  const call = ctx
    .asGateway(caller, ['read', 'message', 'spawn'])
    .session.kill({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['kill'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a menu read to a caller with only the read scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();
  const call = ctx.asGateway(caller, ['read']).session.menu({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['spawn'] },
  });

  expect(caller.requests).toStrictEqual([]);
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

  const caller = buildStubFleetCaller({ answer: () => note });
  const ctx = setupTest();

  const answer = await ctx.asGateway(caller, ['read']).note.get({ note: 'a.b.n1' });

  expect(answer).toStrictEqual(note);
});

test('it refuses a note read to a caller without the read scope', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  await expect(
    ctx.asGateway(caller, ['message', 'spawn']).note.get({ note: 'a.b.n1' }),
  ).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['read'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it refuses an owner-only procedure to a caller with a principal', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.auth.rebind({ session: 'a.b.s1' });

  await expect(call).rejects.toMatchObject({ code: 'unauthorized' });

  expect(caller.requests).toStrictEqual([]);
});

test('it sends an owner-only procedure for a caller with no principal', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ revision: 2, restartPending: [] }) });
  const ctx = setupTest();

  const answer = await ctx.asLocal(caller, ctx.all).session.auth.rebind({ session: 's1' });

  expect(answer).toStrictEqual({ revision: 2, restartPending: [] });
});

test('it refuses a spawn that grants an atcAccess scope the caller lacks', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  const call = ctx.asGateway(caller, ['spawn', 'read']).session.spawn({
    cwd: '/work',
    atcAccess: ['read', 'kill', 'message'],
    idempotencyKey: 'job-1',
  });

  await expect(call).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['kill', 'message'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it sends a spawn that grants only scopes the caller holds, with the fixed terminal size', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ session: buildMockSessionDescriptor() }),
  });

  const ctx = setupTest();

  await ctx
    .asLocal(caller, ['spawn', 'read'])
    .session.spawn({ cwd: '/work', atcAccess: ['read'], idempotencyKey: 'job-1' });

  expect(caller.requests).toStrictEqual([
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
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });
  const ctx = setupTest();

  await ctx.asGateway(caller, ctx.all).session.kill({ session: 'a.b.s1' });

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.kill',
      params: { session: 'a.b.s1', stopOnly: true },
      principal: ctx.principal,
    },
  ]);
});

test('it sends a forget that refuses a pinned or live session', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ confirmToken: 't', expiresAt: 1 }) });
  const ctx = setupTest();

  await ctx.asGateway(caller, ctx.all).session.forget({ session: 'a.b.s1' });

  expect(caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    refusePinned: true,
    refuseLive: true,
  });
});

test('it sends a forget that stops a live session when the caller asks to stop', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ confirmToken: 't', expiresAt: 1 }) });
  const ctx = setupTest();

  await ctx.asGateway(caller, ctx.all).session.forget({ session: 'a.b.s1', stop: true });

  expect(caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    refusePinned: true,
    refuseLive: false,
  });
});

test('it sends an adopt with the fixed terminal size', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });
  const ctx = setupTest();

  await ctx.asGateway(caller, ctx.all).session.adopt({ session: 'a.b.s1' });

  expect(caller.requests[0]?.params).toStrictEqual({
    session: 'a.b.s1',
    cols: 100,
    rows: 30,
  });
});

test('it sends the caller a null principal as no principal', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });
  const ctx = setupTest();

  await ctx.asLocal(caller, ctx.all).session.ack({ session: 's1' });

  expect(caller.requests).toStrictEqual([{ method: 'session.ack', params: { session: 's1' } }]);
});

test('it refuses an input its schema rejects as bad_args and sends nothing', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();

  const call = ctx
    .asGateway(caller, ctx.all)
    .session.message({ session: 'a.b.s1', text: '', idempotencyKey: 'job-1' });

  await expect(call).rejects.toMatchObject({ code: 'bad_args' });

  expect(caller.requests).toStrictEqual([]);
});

test('it turns an answer that fails its output check into internal', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: 'yes' }) });
  const ctx = setupTest();

  await expect(
    ctx.asGateway(caller, ctx.all).session.kill({ session: 'a.b.s1' }),
  ).rejects.toMatchObject({
    code: 'internal',
  });
});

test('it returns an answer with a field the contract does not declare', async () => {
  const answer = { text: 'ready', cols: 80, rows: 24, scrollback: 500 };
  const caller = buildStubFleetCaller({ answer: () => answer });
  const ctx = setupTest();

  const result = await ctx.asGateway(caller, ctx.all).session.screen({ session: 'a.b.s1' });

  expect(result).toStrictEqual(answer);
});

test('it returns a session list from a newer daemon with a state the contract does not list', async () => {
  const session = { ...buildMockGatewayDescriptor(), state: 'paused' };
  const answer = { sessions: [session], daemons: [{ name: 'build-box', state: 'frozen' }] };
  const caller = buildStubFleetCaller({ answer: () => answer });
  const ctx = setupTest();

  const result: unknown = await ctx.asGateway(caller, ctx.all).session.list({});

  expect(result).toStrictEqual(answer);
});

test('it returns a session list from an older daemon that leaves out the optional fields', async () => {
  const session = buildMockGatewayDescriptor();
  const answer = { sessions: [session], daemons: [{ name: 'build-box', state: 'up' }] };
  const caller = buildStubFleetCaller({ answer: () => answer });
  const ctx = setupTest();

  const result: unknown = await ctx.asGateway(caller, ctx.all).session.list({});

  expect(result).toStrictEqual(answer);
});

test('it checks a local answer against the local contract, which has no daemons list', async () => {
  const answer = { sessions: [buildMockSessionDescriptor()] };
  const caller = buildStubFleetCaller({ answer: () => answer });
  const ctx = setupTest();

  const [local, gateway] = await Promise.allSettled([
    ctx.asLocal(caller, ctx.all).session.list({}),
    ctx.asGateway(caller, ctx.all).session.list({}),
  ]);

  expect([local.status, gateway.status]).toStrictEqual(['fulfilled', 'rejected']);
});

test('it keeps the code, message and data of an AtcError from the caller', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('no_such_session', "no session 's9'", { session: 's9' });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'no_such_session',
    message: "no session 's9'",
    data: { session: 's9' },
  });
});

test('it keeps the code, message and data of a gateway error that is no AtcError', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw Object.assign(new Error('daemon build-box is down'), {
        code: 'daemon_unavailable',
        data: { reason: 'daemon_changed' },
      });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: 'daemon build-box is down',
    data: { reason: 'daemon_changed' },
  });
});

test('it keeps an error code outside the fleet error map', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw Object.assign(new Error('the connection dropped'), {
        code: 'mystery_failure',
        data: { retryAfterMs: 500 },
      });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'mystery_failure',
    message: 'the connection dropped',
    data: { retryAfterMs: 500 },
  });
});

test('it turns an error with no code into internal', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new Error('boom');
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'internal', message: 'boom' });
});

test('it keeps the code, message and data of a plain object the caller throws', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      // oxlint-disable-next-line eslint/no-throw-literal -- a client may reject with a plain object
      throw { code: 'no_such_session', message: 'no session s9', data: { session: 's9' } };
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'no_such_session',
    message: 'no session s9',
    data: { session: 's9' },
  });
});

test('it keeps data that is no object on an error the caller throws', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw Object.assign(new Error('the proxy refused'), {
        code: 'connection_lost',
        data: 'proxy detail',
      });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'connection_lost', data: 'proxy detail' });
});

test('it keeps a BAD_REQUEST error that the caller throws with its message and data', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new ORPCError('BAD_REQUEST', {
        message: 'the daemon refused the params',
        data: { field: 'cwd' },
        cause: new ValidationError({ message: 'invalid', issues: [{ message: 'invalid' }] }),
      });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'the daemon refused the params',
    data: { field: 'cwd' },
  });
});

test('it turns a plain object with no code into internal with its message', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      // oxlint-disable-next-line eslint/no-throw-literal -- a client may reject with a plain object
      throw { message: 'the socket closed' };
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'internal', message: 'the socket closed' });
});

test('it refuses a caller without a scope with an error the procedure declares', async () => {
  const caller = buildStubFleetCaller();
  const ctx = setupTest();
  const call = ctx.asGateway(caller, ['message']).dirs.list({});

  await expect(call).rejects.toMatchObject({ code: 'insufficient_scope', defined: true });
});

test('it returns an error code of the fleet map from the caller as a declared error', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('no_such_session', 'no session s9');
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'no_such_session', defined: true });
});

test('it returns an error code outside the fleet map as an undeclared error', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw Object.assign(new Error('timed out'), { code: 'mystery_failure' });
    },
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).session.ack({ session: 'a.b.s9' });

  await expect(call).rejects.toMatchObject({ code: 'mystery_failure', defined: false });
});

test('it gives each procedure the meta and the error map of its contract', () => {
  const ctx = setupTest();
  const router = ctx.createGatewayRouter(buildStubFleetCaller());
  const kill: { meta?: unknown; errorCodes?: string[] } = {};

  traverseContractProcedures({ router, path: [] }, (entry) => {
    if (entry.path.join('.') === 'session.kill') {
      kill.meta = entry.contract['~orpc'].meta;
      kill.errorCodes = Object.keys(entry.contract['~orpc'].errorMap);
    }
  });

  expect([kill.meta, kill.errorCodes?.includes('insufficient_scope')]).toStrictEqual([
    { access: 'principal', readOnly: false, keyed: false, scope: 'kill' },
    true,
  ]);
});

test('it turns an up agents answer whose agent list is malformed into internal', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ daemons: { 'build-box': { state: 'up', agents: 5 } } }),
  });

  const ctx = setupTest();
  const call = ctx.asGateway(caller, ctx.all).agents.list({});

  await expect(call).rejects.toMatchObject({ code: 'internal' });
});

test('it returns an agents answer for a daemon that is down, or in a state a newer daemon adds', async () => {
  const answer = { daemons: { 'build-box': { state: 'down' }, 'lab-box': { state: 'frozen' } } };
  const caller = buildStubFleetCaller({ answer: () => answer });
  const ctx = setupTest();

  const result: unknown = await ctx.asGateway(caller, ctx.all).agents.list({});

  expect(result).toStrictEqual(answer);
});
