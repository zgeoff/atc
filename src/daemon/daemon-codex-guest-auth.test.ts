import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { createStubBin } from '../test-utils/create-stub-bin';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { createStubRecordingCodex } from '../test-utils/create-stub-recording-codex';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

/**
 * The imp target `box` over a stub imp port that holds no identity or
 * secret until the test adds them, in a temp directory. The guest has an
 * atc stand-in, and `fakeCodex` is a stand-in Codex that appends its Codex
 * home and arguments to the `starts` log.
 */
function setupTest() {
  const tmp = setupTempDir('atc-codex-guest-auth-');
  const guestDir = join(tmp.dir, 'g');

  // The imp provider hands the guest this atc binary.
  const guestATC = createStubBin(tmp.dir, 'atc', '#!/bin/sh\nexit 0\n');
  const port = createStubImpPort();

  const provider = new ImpProvider(port, { guestDir, guestATC }, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    dir: tmp.dir,
    port,
    fakeCodex: createStubRecordingCodex(tmp.dir),
    starts: join(tmp.dir, 'codex-starts.log'),
    guestDir,
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
  };
}

test('it starts Codex on an imp in a Codex home of its own, signed in through the oauth secret', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    prefix: 'atc-codex-guest-auth-daemon-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
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
    cwd: ctx.dir,
    agent: 'codex',
    target: 'box',
    prompt: 'go',
  });

  const home = join(
    ctx.guestDir,
    'sessions',
    String(getRecord(spawned, 'session')['id']),
    'codex-home',
  );

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const auth: unknown = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
  const hooks: unknown = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));

  const grants = await Promise.all(
    ctx.port.collectImpNames().map((imp) => ctx.port.readGrants(imp)),
  );

  expect(readFileSync(ctx.starts, 'utf8')).toBe(
    `${home} --dangerously-bypass-hook-trust -c cli_auth_credentials_store="file" --no-daemon go\n`,
  );

  expect(auth).toStrictEqual({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: '2099-01-01T00:00:00Z',
    tokens: {
      id_token:
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InNvbWVvbmVAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiNWYwYzFkN2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDBjMGRlIn19.aW1wLWJyb2tlci1wbGFjZWhvbGRlcg',
      access_token: 'imp-broker-placeholder',
      refresh_token: 'imp-broker-placeholder',
      account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
    },
  });

  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
    'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
  );

  expect(hooks).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${join(ctx.dir, 'atc')}" hook-report --agent codex`,
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${join(ctx.dir, 'atc')}" hook-report --agent codex`,
              timeout: 5,
            },
          ],
        },
      ],
      PermissionRequest: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${join(ctx.dir, 'atc')}" hook-report --agent codex`,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${join(ctx.dir, 'atc')}" hook-report --agent codex`,
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${join(ctx.dir, 'atc')}" hook-report --agent codex`,
              timeout: 3,
            },
          ],
        },
      ],
    },
  });

  expect(grants).toStrictEqual([['codex-chatgpt']]);
});

test.each(['pending', 'needs_login'] as const)(
  'it refuses a spawn while the sign-in is %s, before it creates an imp',
  async (status) => {
    const ctx = setupTest();

    const daemon = await startTestDaemon({
      prefix: 'atc-codex-guest-auth-daemon-',
      options: () => ({
        adapters: buildAgentAdapters(
          parseConfig({
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
      { status, idClaims: { email: 'someone@example.com' } },
    );

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      agent: 'codex',
      target: 'box',
    });

    await Promise.allSettled([spawn]);

    expect(spawn).rejects.toMatchObject({ code: 'auth_signin_needed' });
    expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([]);
    expect(ctx.port.sessionRequests).toStrictEqual([]);
  },
);

test('it refuses a spawn on an impd without oauth secrets', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    prefix: 'atc-codex-guest-auth-daemon-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
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
    { status: 'ready', idClaims: { email: 'someone@example.com' } },
  );

  ctx.port.features = { ...ctx.port.features, oauthSecrets: false };

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'codex',
    target: 'box',
  });

  await Promise.allSettled([spawn]);

  expect(spawn).rejects.toMatchObject({ code: 'auth_impd_too_old' });
  expect(ctx.port.sessionRequests).toStrictEqual([]);
});
