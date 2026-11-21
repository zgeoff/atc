import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { getRecord } from '@atc/core/test-utils/get-record';
import { buildStubBrokeredAgentAdapter } from '@atc/daemon/test-utils/build-stub-brokered-agent-adapter';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/test-utils/create-stub-imp-port';
import { createLocalPTYProvider } from '@atc/execution-local';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { runSessionAction } from './run-session-action';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-session-action-');
  const port = createStubImpPort();

  const provider = createImpProvider(
    port,
    { guestDir: join(temporaryDirectory.path, 'g'), rebindChangedAuth: false },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { directory: temporaryDirectory.path, port, provider };
}

test('it prints the new revision, the adopt command and the sessions pending a restart after a rebind', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-session-action-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

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
    cwd: ctx.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const io = { print: mock(), printError: mock() };

  const code = await runSessionAction(daemon.client, {
    action: 'rebind',
    session: id,
    size: { cols: 80, rows: 24 },
    io,
  });

  expect(code).toBe(0);

  expect(io.print.mock.calls).toStrictEqual([
    [`rebound the host of session ${id} at revision 2; start it with: atc session adopt ${id}`],
    [
      `these sessions keep an older revision's settings until their next launch: ${id}; stop a running one, then atc session adopt <session_id>`,
    ],
  ]);

  expect(io.printError).not.toHaveBeenCalled();
});

test('it starts the terminal of a session whose host is rebound', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-session-action-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

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
    cwd: ctx.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.auth.rebind', { session: id });

  const io = { print: mock(), printError: mock() };

  const code = await runSessionAction(daemon.client, {
    action: 'adopt',
    session: id,
    size: { cols: 80, rows: 24 },
    io,
  });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(code).toBe(0);
  expect(io.print).toHaveBeenCalledExactlyOnceWith(`started a terminal for session ${id}`);
  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', alive: true });
});

test('it prints the refusal with its code and exits 1 when the host still needs a rebind', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-session-action-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

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
    cwd: ctx.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const io = { print: mock(), printError: mock() };

  const code = await runSessionAction(daemon.client, {
    action: 'adopt',
    session: id,
    size: { cols: 80, rows: 24 },
    io,
  });

  expect(code).toBe(1);

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    `atc session adopt: auth_rebind_required: the auth profiles host ${id} uses changed since it was bound; rebind it to adopt them`,
  );

  expect(io.print).not.toHaveBeenCalled();
});
