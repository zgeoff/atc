// oxlint-disable zgeoff/test-beside-module -- tests run-tool.ts; GEO-433 moves it beside its module
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ImpProvider } from '@atc/execution-imp/imp-provider';
import { createStubImpPort } from '@atc/execution-imp/testing/create-stub-imp-port';
import { getOnlyImpName } from '@atc/execution-imp/testing/get-only-imp-name';
import { LocalPTYProvider } from '@atc/execution-local/local-pty-provider';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { buildStubBrokeredAgentAdapter } from '@atc/test-utils/build-stub-brokered-agent-adapter';
import { getRecord } from '@atc/test-utils/get-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildPrincipalCaller } from './build-principal-caller';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

/**
 * A stub imp port whose impd holds nothing until the test adds it, the imp
 * provider over it, which each test hands to the daemon it starts as the
 * target `box`.
 */
function setupTest() {
  const tmp = setupTempDir('atc-run-tool-auth-');
  const port = createStubImpPort();

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'g'), rebindChangedAuth: false },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { dir: tmp.dir, port, provider };
}

test('it rebinds the host of a session whose restore was refused for a changed auth selection', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const rebound = await runTool(
    caller,
    'atc_session_auth_rebind',
    { session: id },
    { callerSessionID: null },
  );

  const grants = await ctx.port.readGrants(imp);

  expect(rebound.structured).toStrictEqual({ revision: 2, restartPending: [id] });
  expect(grants).toIncludeSameMembers(['glm', 'judge']);
});

test('it adopts a session whose restore was refused once its host is rebound', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const toolContext = { callerSessionID: null };

  await runTool(caller, 'atc_session_auth_rebind', { session: id }, toolContext);

  const adopted = await runTool(caller, 'atc_session_adopt', { session: id }, toolContext);
  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(adopted.structured).toStrictEqual({ adopted: true });
  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', alive: true });
});

test('it refuses a rebind from a remote client acting as a principal and binds nothing', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',

      // The remote client acts as ops, which may use box.
      principals: new Map([['ops', ['box']]]),
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const owner = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => owner.stop());

  const caller = buildPrincipalCaller(owner, { id: 'ops', name: 'ops-console' });

  const rebound = runTool(
    caller,
    'atc_session_auth_rebind',
    { session: id },
    { callerSessionID: null },
  );

  await rebound.catch(() => null);

  const grants = await ctx.port.readGrants(imp);

  expect(rebound).rejects.toMatchObject({ code: 'unauthorized' });
  expect(grants).toStrictEqual(['glm']);
});
