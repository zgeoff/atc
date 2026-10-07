import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';

const ACCOUNT_ID = '5f0c1d7e-0000-4000-8000-00000000c0de';
const CHATGPT_RULE = { host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' } as const;

/**
 * A real daemon with an imp target `box` over a fixture imp port whose
 * impd an operator prepared: the token `atc-runtime` manages `atc-*` imps
 * and may grant `codex-chatgpt`, which impd holds as an oauth secret for
 * chatgpt.com in the sign-in state `status`. The guest has an atc
 * stand-in, and Codex is a fake that records its arguments and its Codex
 * home in a marker file.
 */
async function setupTest(status: 'ready' | 'pending' | 'needs_login' = 'ready') {
  const tmp = setupTempDir('atc-codex-guest-auth-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const guestDir = join(tmp.dir, 'g');
  const fakeCodex = join(tmp.dir, 'fake-codex');
  const marker = join(tmp.dir, 'started');
  const guestATC = join(tmp.dir, 'atc');

  writeFileSync(fakeCodex, `#!/bin/sh\necho "$CODEX_HOME $*" >> "${marker}"\nexec sleep 30\n`, {
    mode: 0o755,
  });

  writeFileSync(guestATC, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const port = new FixtureImpPort();

  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['codex-chatgpt'],
  });

  port.createSecret('codex-chatgpt', 'oauth', [CHATGPT_RULE], {
    status,
    idClaims: {
      email: 'someone@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
    },
  });

  const provider = new ImpProvider(port, { guestDir, guestATC }, { atcBinary: null });

  const config = parseConfig({
    authProfiles: { codex: { secret: 'codex-chatgpt', kind: 'oauth', ...CHATGPT_RULE } },
    agents: { codex: { bin: fakeCodex, auth: { profiles: ['codex'] } } },
  });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: buildAgentAdapters(config),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    marker,
    fakeCodex,
    guestDir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it starts Codex on an imp in a Codex home of its own, signed in through the oauth secret', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'codex',
    target: 'box',
    prompt: 'go',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const home = join(daemon.guestDir, 'sessions', id, 'codex-home');

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const auth: unknown = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
  const hooks: unknown = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));

  expect({
    started: readFileSync(daemon.marker, 'utf8'),
    auth,
    config: readFileSync(join(home, 'config.toml'), 'utf8'),
    hooks,
    grants: daemon.port.calls.filter((call) => call.startsWith('grants.add')),
  }).toMatchObject({
    started: `${home} --dangerously-bypass-hook-trust go\n`,
    auth: {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'imp-broker-placeholder',
        refresh_token: 'imp-broker-placeholder',
        account_id: ACCOUNT_ID,
      },
    },
    config: 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
    hooks: {
      hooks: { Stop: [{ hooks: [{ command: expect.toEndWith(' hook-report --agent codex') }] }] },
    },
    grants: [expect.toEndWith(' codex-chatgpt')],
  });
});

test.each(['pending', 'needs_login'] as const)(
  'it refuses a spawn while the sign-in is %s, before it creates an imp',
  async (status) => {
    await using daemon = await setupTest(status);

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: '/tmp',
      agent: 'codex',
      target: 'box',
    });

    expect(spawn).rejects.toMatchObject({ code: 'auth_signin_needed' });

    await spawn.catch(() => null);

    expect(daemon.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([]);
    expect(daemon.port.sessionRequests).toStrictEqual([]);
  },
);

test('it refuses a spawn on an impd without oauth secrets', async () => {
  await using daemon = await setupTest();

  daemon.port.features = { ...daemon.port.features, oauthSecrets: false };

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'codex',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_impd_too_old' });

  await spawn.catch(() => null);

  expect(daemon.port.sessionRequests).toStrictEqual([]);
});
