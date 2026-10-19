import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import {
  buildMockHostServices,
  createStubBin,
  createStubRecordingClaude,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// Only a broker that sets the credential for api.github.com, as impd does
// for an imp, answers this; Bun 1.4.2's skipIf takes a boolean and has no
// in-body skip, so the probe runs when the file loads.
const isBrokered = await fetch('https://api.github.com/user', {
  signal: AbortSignal.timeout(10_000),
}).then(
  (response) => response.ok,
  () => false,
);

function setupTest() {
  const tmp = setupTempDir('atc-brokered-placeholder-');
  const port = createStubImpPort();
  const fakeClaude = createStubRecordingClaude(tmp.dir);
  const guestATC = createStubBin(tmp.dir, 'atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    dir: tmp.dir,
    port,
    fakeClaude,
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
  };
}

test.skipIf(!isBrokered)(
  'it gives a session on an imp the placeholder a brokered host accepts in place of the credential',
  async () => {
    const ctx = setupTest();

    ctx.port.setIdentity({
      kind: 'token',
      name: 'atc-runtime',
      scope: 'manage',
      imps: ['atc-*'],
      grantable: ['gh-api'],
    });

    ctx.port.createSecret('gh-api', 'custom', [
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
    ]);

    const daemon = await startTestDaemon({
      options: () => ({
        adapters: buildAgentAdapters(
          parseConfig(SHIPPED_HARNESS_PLUGINS, {
            authProfiles: {
              'gh-api': {
                secret: 'gh-api',
                host: 'api.github.com',
                header: 'authorization',
                scheme: 'bearer',
              },
            },
            agents: {
              hub: {
                kind: 'claude',
                bin: ctx.fakeClaude,
                baseURL: 'https://api.github.com',
                auth: {
                  profiles: ['gh-api'],
                  placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
                },
              },
            },
          }),
          buildMockHostServices(),
        ),
        targets: ctx.targets,
        defaultTarget: 'box',
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      agent: 'hub',
      target: 'box',
    });

    const id = String(getRecord(spawned, 'session')['id']);

    await waitFor(() => {
      expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
    });

    const settingsFile = join(ctx.dir, 'g', 'sessions', id, 'auth-r1', 'settings.json');
    const settings = getRecord(JSON.parse(readFileSync(settingsFile, 'utf8')), 'env');
    const token = String(settings['ANTHROPIC_AUTH_TOKEN']);

    const response = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    expect(token).toBe('broker-placeholder');
    expect(response.status).toBe(200);
  },
);
