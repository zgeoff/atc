import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort, getOnlyImpName } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { createStateStore } from '@atc/store';
import {
  buildStubBrokeredAgentAdapter,
  getRecord,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-static-secret-');
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

test('it provisions the host of a spawn whose custom secret impd lists as static', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-static-secret-daemon-',
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
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'static', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  const store = await createStateStore(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const binding = await store.readAuthBinding(toSessionID(id));
  const grants = await ctx.port.readGrants(imp);

  expect(
    ctx.port.sessionRequests.map((request) => [
      request.kind,
      request.kind === 'start' ? request.require : undefined,
    ]),
  ).toStrictEqual([['start', ['broker']]]);

  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'ready', revision: 1, hostName: imp });
});

test('it revives a session bound to a custom secret after impd lists that secret as static', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-static-secret-daemon-',
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
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  // The host moves to impd 5, whose migration rewrites the stored kind in
  // place and keeps the secret's rules and grants.
  ctx.port.createSecret('glm', 'static', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const grants = await ctx.port.readGrants(imp);

  expect(
    ctx.port.sessionRequests.map((request) => [
      request.kind,
      request.kind === 'start' ? request.require : undefined,
    ]),
  ).toStrictEqual([
    ['start', ['broker']],
    ['start', ['broker']],
  ]);

  expect(grants).toStrictEqual(['glm']);
});
