import { expect, expectTypeOf, test } from 'bun:test';
import type { ContractRouterClient } from '@orpc/contract';
import { z } from 'zod';
import { DAEMON_CONTRACT } from '../daemon-contract/daemon-contract';
import { DAEMON_ERROR_MAP } from '../daemon-contract/daemon-error-map';
import type { GatewaySessionID } from '../ids/gateway-session-id';
import { collectContractProcedures } from '../test-utils/collect-contract-procedures';
import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from './fleet-contract';
import { FLEET_ERROR_MAP } from './fleet-error-map';
import { FLEET_PROCEDURE_SCOPES } from './fleet-procedure-scopes';

test.each<{
  method: string;
  fields: string[];
  localOnly?: string[];
  fanOut?: boolean;
}>([
  {
    method: 'session.spawn',
    fields: [
      'cwd',
      'name',
      'prompt',
      'agent',
      'model',
      'effort',
      'pluginDirs',
      'idempotencyKey',
      'target',
      'workspace',
      'trustClonedWorkspace',
      'scope',
      'atcAccess',
    ],
    localOnly: ['parent'],
  },
  { method: 'session.message', fields: ['session', 'text', 'idempotencyKey'] },
  { method: 'session.kill', fields: ['session'] },
  { method: 'session.forget', fields: ['session', 'confirmToken', 'stop'] },
  { method: 'session.submit', fields: ['session', 'text'] },
  {
    method: 'session.choose',
    fields: ['session', 'menuToken', 'option', 'label', 'key'],
  },
  { method: 'session.update', fields: ['session', 'name', 'pinned', 'parent'] },
  { method: 'session.scope.add', fields: ['session', 'scope'] },
  { method: 'session.read', fields: ['session', 'cursor', 'limit'] },
  { method: 'message.get', fields: ['message', 'waitMs'] },
  { method: 'note.get', fields: ['note'] },
  { method: 'answer.get', fields: ['answer'] },
  { method: 'session.get', fields: ['session'] },
  { method: 'session.screen', fields: ['session'] },
  { method: 'session.menu', fields: ['session'] },
  { method: 'session.ack', fields: ['session'] },
  { method: 'session.adopt', fields: ['session'] },
  { method: 'session.auth.rebind', fields: ['session'] },
  { method: 'dirs.list', fields: [] },
  { method: 'agents.list', fields: [], fanOut: true },
  { method: 'session.list', fields: [], fanOut: true },
  {
    method: 'events.read',
    fields: ['cursor', 'limit', 'waitMs', 'session'],
    fanOut: true,
  },
])('it holds only the allowlisted input fields of $method in each fleet contract', (row) => {
  const keysOf = (contract: unknown): readonly string[] =>
    collectContractProcedures(contract).find((procedure) => procedure.method === row.method)
      ?.inputKeys ?? ['missing'];

  expect([
    [...keysOf(FLEET_CONTRACT)].toSorted(),
    [...keysOf(LOCAL_FLEET_CONTRACT)].toSorted(),
  ]).toStrictEqual([
    [...row.fields, ...(row.fanOut === true ? [] : ['daemon'])].toSorted(),
    [...row.fields, ...(row.localOnly ?? [])].toSorted(),
  ]);
});

test('it holds the daemons.list procedure in FLEET_CONTRACT alone, with no input field', () => {
  const gateway = collectContractProcedures(FLEET_CONTRACT).find(
    (procedure) => procedure.method === 'daemons.list',
  );

  const local = collectContractProcedures(LOCAL_FLEET_CONTRACT).find(
    (procedure) => procedure.method === 'daemons.list',
  );

  expect([gateway?.inputKeys, local]).toStrictEqual([[], undefined]);
});

test('it holds no procedure beyond the design list in either contract', () => {
  const local = collectContractProcedures(LOCAL_FLEET_CONTRACT)
    .map((procedure) => procedure.method)
    .toSorted();

  const gateway = collectContractProcedures(FLEET_CONTRACT)
    .map((procedure) => procedure.method)
    .toSorted();

  expect([gateway, local]).toStrictEqual([
    [...local, 'daemons.list'].toSorted(),
    [
      'agents.list',
      'answer.get',
      'dirs.list',
      'events.read',
      'message.get',
      'note.get',
      'session.ack',
      'session.adopt',
      'session.auth.rebind',
      'session.choose',
      'session.forget',
      'session.get',
      'session.kill',
      'session.list',
      'session.menu',
      'session.message',
      'session.read',
      'session.scope.add',
      'session.screen',
      'session.spawn',
      'session.submit',
      'session.update',
    ],
  ]);
});

test.each<{ scope: string; methods: string[] }>([
  {
    scope: 'read',
    methods: [
      'daemons.list',
      'agents.list',
      'dirs.list',
      'session.list',
      'session.get',
      'session.read',
      'session.screen',
      'message.get',
      'note.get',
      'answer.get',
      'events.read',
    ],
  },
  {
    scope: 'message',
    methods: ['session.message', 'session.update', 'session.ack'],
  },
  {
    scope: 'spawn',
    methods: [
      'session.spawn',
      'session.submit',
      'session.menu',
      'session.choose',
      'session.adopt',
      'session.scope.add',
      'session.auth.rebind',
    ],
  },
  { scope: 'kill', methods: ['session.kill', 'session.forget'] },
])('it gives the $scope scope to its procedures in the scope table and in each meta', (row) => {
  const metaScopes = collectContractProcedures(FLEET_CONTRACT)
    .filter((procedure) => row.methods.includes(procedure.method))
    .map((procedure) => z.object({ scope: z.string() }).parse(procedure.meta).scope);

  expect([
    row.methods.map((method): unknown => Reflect.get(FLEET_PROCEDURE_SCOPES, method)),
    metaScopes,
  ]).toStrictEqual([row.methods.map(() => row.scope), row.methods.map(() => row.scope)]);
});

test('it copies access, readOnly and keyed from the daemon procedure of each fleet procedure', () => {
  const traits = z.object({
    access: z.string(),
    readOnly: z.boolean(),
    keyed: z.boolean(),
  });

  const daemon = new Map(
    collectContractProcedures(DAEMON_CONTRACT).map((procedure) => [
      procedure.method,
      traits.parse(procedure.meta),
    ]),
  );

  const fleet = collectContractProcedures(FLEET_CONTRACT).filter(
    (procedure) => procedure.method !== 'daemons.list',
  );

  expect(fleet.map((procedure) => traits.parse(procedure.meta))).toStrictEqual(
    fleet.map(
      (procedure) =>
        daemon.get(procedure.method) ?? {
          access: 'missing',
          readOnly: false,
          keyed: false,
        },
    ),
  );
});

test.each(['session.spawn', 'session.message'])(
  'it requires an idempotency key of 1 to 180 characters on %s',
  (method) => {
    const procedure = collectContractProcedures(FLEET_CONTRACT).find(
      (entry) => entry.method === method,
    );

    const keys = [undefined, '', 'k', 'k'.repeat(180), 'k'.repeat(181)];

    const accepted = keys.map(
      (key) =>
        procedure?.inputSchema.safeParse({
          session: 's1',
          text: 'hi',
          cwd: '/work',
          idempotencyKey: key,
        }).success,
    );

    expect(accepted).toStrictEqual([false, false, true, true, false]);
  },
);

test('it declares the three gateway error codes in FLEET_ERROR_MAP and not in DAEMON_ERROR_MAP', () => {
  const extra = Object.keys(FLEET_ERROR_MAP).filter((code) => !(code in DAEMON_ERROR_MAP));

  expect(extra.toSorted()).toStrictEqual([
    'daemon_unauthorized',
    'daemon_unavailable',
    'insufficient_scope',
  ]);
});

test.each([
  'session.get',
  'session.screen',
  'session.menu',
  'session.ack',
  'session.adopt',
  'session.auth.rebind',
  'session.kill',
  'session.submit',
  'session.read',
  'session.update',
  'session.scope.add',
  'session.forget',
  'session.choose',
  'session.message',
  'events.read',
])('it accepts a gateway session id as the session of %s', (method) => {
  const procedure = collectContractProcedures(FLEET_CONTRACT).find(
    (entry) => entry.method === method,
  );

  const result = procedure?.inputSchema.safeParse({
    session: 'build-box.k3f9.s7-m4x2p',
    text: 'hi',
    idempotencyKey: 'k1',
    menuToken: 't',
    key: 'escape',
    scope: {},
  });

  expect(result?.success).toBe(true);
});

test('it drops a key outside the allowlist from the input of every procedure in both contracts', () => {
  const sample = {
    session: 'build-box.k3f9.s7-m4x2p',
    text: 'hi',
    idempotencyKey: 'k1',
    menuToken: 't',
    key: 'escape',
    scope: {},
    message: 'a.b.m1',
    note: 'a.b.n1',
    answer: 'a.b.r1',
    cwd: '/work',
    surprise: true,
  };

  const parsed = [FLEET_CONTRACT, LOCAL_FLEET_CONTRACT].flatMap((contract) =>
    collectContractProcedures(contract).map((procedure) => {
      const result = procedure.inputSchema.safeParse(sample);

      return { method: procedure.method, success: result.success, data: result.data };
    }),
  );

  expect(parsed.map((entry) => entry.success)).toStrictEqual(parsed.map(() => true));

  expect(parsed.map((entry) => Reflect.has(entry.data ?? {}, 'surprise'))).toStrictEqual(
    parsed.map(() => false),
  );
});

type GatewayClient = ContractRouterClient<typeof FLEET_CONTRACT>;

type LocalClient = ContractRouterClient<typeof LOCAL_FLEET_CONTRACT>;

type InputOf<TProcedure extends (...args: never[]) => unknown> = NonNullable<
  Parameters<TProcedure>[0]
>;

test('it types the input of each client by its allowlist, with no key outside it', () => {
  expectTypeOf<keyof InputOf<GatewayClient['dirs']['list']>>().toEqualTypeOf<'daemon'>();
  expectTypeOf<InputOf<LocalClient['dirs']['list']>>().toEqualTypeOf<Record<string, never>>();
  expectTypeOf<InputOf<GatewayClient['daemons']['list']>>().toEqualTypeOf<Record<string, never>>();
  expectTypeOf<'daemon'>().toExtend<keyof InputOf<GatewayClient['session']['spawn']>>();
  expectTypeOf<'daemon'>().not.toExtend<keyof InputOf<LocalClient['session']['spawn']>>();
  expectTypeOf<'parent'>().toExtend<keyof InputOf<LocalClient['session']['spawn']>>();
  expectTypeOf<'parent'>().not.toExtend<keyof InputOf<GatewayClient['session']['spawn']>>();
});

test('it types the answer of each client by its schema', () => {
  type GatewaySpawn = Awaited<ReturnType<GatewayClient['session']['spawn']>>;

  type LocalSpawn = Awaited<ReturnType<LocalClient['session']['spawn']>>;

  expectTypeOf<GatewaySpawn['session']['id']>().toEqualTypeOf<GatewaySessionID>();
  expectTypeOf<LocalSpawn['session']['id']>().not.toBeUnknown();
  expectTypeOf<LocalSpawn['session']['id']>().not.toEqualTypeOf<GatewaySessionID>();
});
