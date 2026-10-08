import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildMockImpSessionRequest } from '../test-utils/build-mock-imp-session-request';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startStubImpd } from '../test-utils/start-stub-impd';
import { waitFor } from '../test-utils/wait-for';
import { ImpClientPort } from './imp-client-port';
import { readImpToken } from './read-imp-token';

/**
 * An impd stand-in on a real HTTP port.
 */
function setupTest() {
  const impd = startStubImpd();

  return { impd };
}

test('it calls impd with the token its token file holds', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  const features = await port.readFeatures();

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: false,
    secretRebind: false,
    execRequire: false,
    oauthSecrets: false,
  });

  expect(ctx.impd.authorizations).toStrictEqual(['Bearer file-token']);
});

test('it calls impd with the new token on the next call after the token file changes', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  await port.readFeatures();

  writeFileSync(tokenPath, 'second-token\n');

  await port.readFeatures();

  expect(ctx.impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
});

test('it refuses a call as unauthorized without reaching impd when the token file is empty', () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  expect(port.readFeatures()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(ctx.impd.authorizations).toStrictEqual([]);
});

test('it ends a session connection as unauthorized without reaching impd when the token file is empty', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  const connection = port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
  expect(ctx.impd.authorizations).toStrictEqual([]);
});

test('it refuses a reverse forward as unauthorized without reaching impd when the token file is empty', () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  expect(forward.listening).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(ctx.impd.authorizations).toStrictEqual([]);
});

test('it opens a guest connection relay with the token its token file holds when the relay opens', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  registerTestCleanup(() => {
    forward.stop();
  });

  await forward.listening;

  writeFileSync(tokenPath, 'second-token\n');

  const [control] = ctx.impd.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(
    () => {
      expect(ctx.impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
    },
    { timeoutMs: 2000 },
  );
});

test.each([
  ['absent', false, { sessionOffsets: true, leases: true }],
  [
    'false',
    false,
    {
      sessionOffsets: true,
      leases: true,
      grantableTokens: false,
      secretRebind: false,
      execRequire: false,
      oauthSecrets: false,
    },
  ],
  [
    'strings',
    false,
    {
      sessionOffsets: true,
      leases: true,
      grantableTokens: 'true',
      secretRebind: 'true',
      execRequire: 'true',
      oauthSecrets: 'true',
    },
  ],
  [
    'true',
    true,
    {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      execRequire: true,
      oauthSecrets: true,
    },
  ],
])('it reads grant and exec requirement flags sent as %s as %p', async (_kind, flag, sent) => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/info', { status: 200, json: { features: sent } });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const features = await port.readFeatures();

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: flag,
    secretRebind: flag,
    execRequire: flag,
    oauthSecrets: flag,
  });
});

test('it sends a command stdin larger than one WebSocket message impd takes', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const file = join(tmp.dir, 'token');

  writeFileSync(file, 't0');

  ctx.impd.exec.reply = 'count';

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(file) });

  const result = await port.runCommand('imp-a', {
    argv: ['wc', '-c'],
    stdin: new Uint8Array(5 * 1024 * 1024),
  });

  expect({ code: result.code, stdout: new TextDecoder().decode(result.stdout) }).toStrictEqual({
    code: 0,
    stdout: '5242880\n',
  });
});

test('it returns the exit of a command that ends before it reads its stdin', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const file = join(tmp.dir, 'token');

  writeFileSync(file, 't0');

  ctx.impd.exec.reply = 'exit-early';

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(file) });

  const result = await port.runCommand('imp-a', {
    argv: ['false'],
    stdin: new Uint8Array(5 * 1024 * 1024),
  });

  expect(result.code).toBe(2);
});

test('it rejects a command whose start impd refuses with the refusal', () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const file = join(tmp.dir, 'token');

  writeFileSync(file, 't0');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(file) });

  expect(port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('it reads the caller identity impd answers tokens.whoami with', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/tokens/whoami', {
    status: 200,
    json: { kind: 'token', name: 'atc', scope: 'manage', imps: ['atc-*'], grantable: ['glm'] },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const identity = await port.readIdentity();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  expect(ctx.impd.calls.map((call) => call.path)).toStrictEqual(['/rpc/tokens/whoami']);
});

test('it reads an identity without a grantable list as one that grants nothing', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/tokens/whoami', {
    status: 200,
    json: { kind: 'token', name: 'admin', scope: 'manage', imps: null },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const identity = await port.readIdentity();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'admin',
    scope: 'manage',
    imps: null,
    grantable: [],
  });
});

test('it lists each secret with its kind, rules, and imps', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/secrets/list', {
    status: 200,
    json: [
      {
        name: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        imps: ['atc-s1'],
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        name: 'reg',
        kind: 'custom',
        rules: [{ host: 'reg.example.com', header: 'authorization', scheme: 'basic', user: 'bot' }],
        imps: [],
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const secrets = await port.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'glm',
      kind: 'custom',
      rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      imps: ['atc-s1'],
    },
    {
      name: 'reg',
      kind: 'custom',
      rules: [{ host: 'reg.example.com', header: 'authorization', scheme: 'basic', user: 'bot' }],
      imps: [],
    },
  ]);
});

test('it lists an oauth secret with its sign-in status and ID token claims', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/secrets/list', {
    status: 200,
    json: [
      {
        name: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        oauth: {
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'app_example',
          tokenFormat: 'json',
          status: 'ready',
          expiresAt: '2026-10-11T00:00:00.000Z',
          refreshedAt: '2026-10-01T00:00:00.000Z',
          error: null,
          idClaims: { email: 'someone@example.com' },
        },
      },
    ],
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const secrets = await port.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'codex-chatgpt',
      kind: 'oauth',
      rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      imps: [],
      oauth: { status: 'ready', idClaims: { email: 'someone@example.com' } },
    },
  ]);
});

test('it lists the secrets granted to the named imp', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/list', { status: 200, json: ['glm'] });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const grants = await port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
  expect(ctx.impd.calls).toStrictEqual([{ path: '/rpc/grants/list', input: { name: 'atc-s1' } }]);
});

test('it grants a secret to the named imp', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/add', { status: 200, json: {} });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  await port.createGrant('atc-s1', 'glm');

  expect(ctx.impd.calls).toStrictEqual([
    { path: '/rpc/grants/add', input: { name: 'atc-s1', secret: 'glm' } },
  ]);
});

test('it reports a revoke of a grant impd held as done', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/delete', { status: 200, json: {} });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(true);

  expect(ctx.impd.calls).toStrictEqual([
    { path: '/rpc/grants/delete', input: { name: 'atc-s1', secret: 'glm' } },
  ]);
});

test('it reports a revoke of a grant impd no longer holds as nothing removed', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/delete', {
    status: 404,
    json: {
      defined: true,
      code: 'NOT_FOUND',
      status: 404,
      message: 'Not found',
      data: { kind: 'grant', name: 'atc-s1/glm' },
    },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(false);
});

test('it rejects a revoke on an imp impd does not hold', () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/delete', {
    status: 404,
    json: {
      defined: true,
      code: 'NOT_FOUND',
      status: 404,
      message: 'Not found',
      data: { kind: 'imp', name: 'atc-s1' },
    },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  expect(port.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'atc-s1' },
  });
});

test('it rejects a revoke impd forbids with its reason', () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/grants/delete', {
    status: 403,
    json: {
      defined: true,
      code: 'FORBIDDEN',
      status: 403,
      message: 'Forbidden',
      data: { reason: 'not_grantable' },
    },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  expect(port.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it reads the id of the imp under a name', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/imps/get', {
    status: 200,
    json: { id: '0199a1b2-0000-7000-8000-000000000001', name: 'atc-s1', state: 'sleeping' },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const imp = await port.readImp('atc-s1');

  expect(imp).toStrictEqual({
    id: '0199a1b2-0000-7000-8000-000000000001',
    name: 'atc-s1',
    state: 'sleeping',
    leases: [],
    otherLeaseCount: 0,
  });
});

test('it reads the id of the imp it creates', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/imps/create', {
    status: 200,
    json: { id: '0199a1b2-0000-7000-8000-000000000002', name: 'atc-s2', state: 'creating' },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const imp = await port.createImp({ name: 'atc-s2' });

  expect(imp).toStrictEqual({
    id: '0199a1b2-0000-7000-8000-000000000002',
    name: 'atc-s2',
    state: 'creating',
    leases: [],
    otherLeaseCount: 0,
  });
});

test('it sends the requirements of a start to impd and ends the connection with its refusal', async () => {
  const ctx = setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  ctx.impd.answers.set('/rpc/system/info', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execRequire: true } },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const request = buildMockImpSessionRequest({ require: ['broker'] });
  const connection = port.openSession(request, { onStarted: () => {}, onOutput: () => {} });

  const outcome = await connection.outcome;

  expect(ctx.impd.execOpens).toStrictEqual([
    {
      type: 'start',
      name: request.name,
      session: request.session,
      argv: request.argv,
      tty: true,
      env: request.env,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      require: ['broker'],
    },
  ]);

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });
});

test('it closes a session connection whose gate shuts as it opens, sending impd nothing', async () => {
  const ctx = setupTest();

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const gates: string[] = [];

  const connection = port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => {
      gates.push('checked');

      return false;
    },
  );

  await connection.outcome;

  expect(gates).toStrictEqual(['checked']);
  expect(ctx.impd.execOpens).toStrictEqual([]);
});

test('it closes a session connection whose gate throws as it opens, sending impd nothing', async () => {
  const ctx = setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  ctx.impd.answers.set('/rpc/system/info', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execRequire: true } },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const connection = port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => {
      throw new Error('the gate broke');
    },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'closed', reason: 'closed before sending' });
  expect(ctx.impd.execOpens).toStrictEqual([]);
});

test('it sends the request of a session connection whose gate stays open as it opens', async () => {
  const ctx = setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  ctx.impd.answers.set('/rpc/system/info', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execRequire: true } },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const connection = port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => true,
  );

  const outcome = await connection.outcome;

  // The stand-in refuses every start it is sent.
  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  expect(ctx.impd.execOpens).toStrictEqual([
    {
      type: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
      tty: true,
      require: ['broker'],
    },
  ]);
});

test('it sends the requirements of an attach to impd', async () => {
  const ctx = setupTest();

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const connection = port.openSession(
    {
      kind: 'attach',
      name: 'atc-s1',
      session: 'atc-s1',
      cols: 80,
      rows: 24,
      wake: false,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await connection.outcome;

  expect(ctx.impd.execOpens).toStrictEqual([
    {
      type: 'attach',
      name: 'atc-s1',
      session: 'atc-s1',
      cols: 80,
      rows: 24,
      wake: false,
      require: ['broker'],
    },
  ]);
});

test('it sends a start without requirements when the request holds none', async () => {
  const ctx = setupTest();

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const connection = port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await connection.outcome;

  expect(ctx.impd.execOpens).toStrictEqual([
    {
      type: 'start',
      name: 'atc-s1',
      session: 'atc-s1',
      argv: ['claude'],
      tty: true,
      env: {},
      cwd: '/work',
      cols: 80,
      rows: 24,
    },
  ]);
});
