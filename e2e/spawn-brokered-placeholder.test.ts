import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import {
  buildMockHostServices,
  createStubBin,
  createStubBrokeredClaude,
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
  const temporaryDirectory = setupTempDir('atc-brokered-placeholder-');
  const port = createStubImpPort();

  const fakeClaude = createStubBrokeredClaude(
    temporaryDirectory.path,
    'https://api.github.com/user',
  );

  const guestATC = createStubBin(temporaryDirectory.path, 'atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    port,
    { guestDir: join(temporaryDirectory.path, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    directory: temporaryDirectory.path,
    port,
    fakeClaude,
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
  };
}

test.skipIf(!isBrokered)(
  'it gives a session on an imp a placeholder that the session sends to a brokered host, which accepts it',
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
      cwd: daemon.directory,
      agent: 'hub',
      target: 'box',
    });

    const id = String(getRecord(spawned, 'session')['id']);
    const settingsFile = join(ctx.directory, 'g', 'sessions', id, 'auth-r1', 'settings.json');

    await waitFor(() => {
      expect(existsSync(join(ctx.directory, 'brokered-status'))).toBeTrue();
    });

    const settings: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));

    expect(settings).toHaveProperty('env.ANTHROPIC_AUTH_TOKEN', 'broker-placeholder');
    expect(readFileSync(join(ctx.directory, 'brokered-status'), 'utf8')).toBe('200');
  },
);
