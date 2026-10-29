import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import {
  buildMockHostServices,
  createStubBin,
  createStubRecordingCodex,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// An imp provider over the stub imp port, whose guest folder sits in a temp
// directory, and a stand-in Codex that records each start.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-guest-name-');
  const guestDir = join(temporaryDirectory.path, 'g');
  const guestATC = createStubBin(temporaryDirectory.path, 'atc', '#!/bin/sh\necho 1.0.0\n');
  const port = createStubImpPort();

  const provider = createImpProvider(
    port,
    { guestDir, guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    directory: temporaryDirectory.path,
    port,
    fakeCodex: createStubRecordingCodex(temporaryDirectory.path),
    starts: join(temporaryDirectory.path, 'codex-starts.log'),
    guestDir,
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
  };
}

test('it names a brokered Codex session on an imp from the session index in its own Codex home', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    prefix: 'atc-codex-guest-name-daemon-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          authProfiles: {
            codex: {
              secret: 'codex-chatgpt',
              kind: 'oauth',
              host: 'chatgpt.com',
              header: 'authorization',
              scheme: 'bearer',
            },
          },
          agents: { codex: { bin: ctx.fakeCodex, auth: { profiles: ['codex'] } } },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['codex-chatgpt'],
  });

  ctx.port.createSecret(
    'codex-chatgpt',
    'oauth',
    [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    {
      status: 'ready',
      idClaims: {
        email: 'someone@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
        },
      },
    },
  );

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'codex',
    target: 'box',
    prompt: 'go',
  });

  const id = getRecord(spawned, 'session')['id'];
  const home = join(ctx.guestDir, 'sessions', String(id), 'codex-home');

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  writeFileSync(
    join(home, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"tidy the docs","updated_at":"2026-10-29T00:00:00Z"}\n',
  );

  await daemon.sendHookLines({ atcId: id, event: 'Stop', payload: { session_id: 'c-1' } });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(got, 'session')['name']).toBe('tidy the docs');
  });
});
