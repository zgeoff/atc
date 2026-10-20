import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildStubClock,
  registerTestCleanup,
  setupTempDir,
  startStubImpd,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { ImpClientPort } from './imp-client-port';
import { readImpToken } from './read-imp-token';
import { buildMockImpSessionRequest } from './testing/build-mock-imp-session-request';

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

  await port.verifyVersion();

  expect(ctx.impd.authorizations).toStrictEqual(['Bearer file-token']);
});

test('it calls impd with the new token on the next call after the token file changes', async () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  await port.verifyVersion();

  writeFileSync(tokenPath, 'second-token\n');

  await port.verifyVersion();

  expect(ctx.impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
});

test.each(['2.2.0', '2.7.0'])('it accepts impd %s', async (version) => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/info', { status: 200, json: { version } });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'version-token' });

  await expect(port.verifyVersion()).toResolve();
});

test('it refuses impd 2.1.0 as outdated, naming both versions', () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/info', { status: 200, json: { version: '2.1.0' } });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'version-token' });

  expect(port.verifyVersion()).rejects.toMatchObject({
    code: 'IMPD_OUTDATED',
    message: 'impd 2.1.0 is older than 2.2.0, the oldest impd this atc supports; upgrade impd',
    data: { version: '2.1.0', minimum: '2.2.0' },
  });
});

test('it refuses an impd whose version does not parse as outdated', () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/info', { status: 200, json: { version: 'nightly' } });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'version-token' });

  expect(port.verifyVersion()).rejects.toMatchObject({
    code: 'IMPD_OUTDATED',
    message:
      "impd reports version 'nightly', which atc cannot compare with 2.2.0, the oldest impd this atc supports; upgrade impd",
    data: { version: 'nightly', minimum: '2.2.0' },
  });
});

test('it answers the version checks within 30 seconds of a read with its one call to impd', async () => {
  const ctx = setupTest();
  const stub = buildStubClock(1000);

  const port = new ImpClientPort({
    url: ctx.impd.url,
    readToken: () => 'version-token',
    now: stub.now,
  });

  await Promise.all([port.verifyVersion(), port.verifyVersion()]);

  stub.advance(29_999);

  await port.verifyVersion();

  expect(ctx.impd.calls).toStrictEqual([{ path: '/rpc/system/info', input: undefined }]);
});

test('it refuses an outdated impd again within 30 seconds from its one call to impd', async () => {
  const ctx = setupTest();
  const stub = buildStubClock(1000);

  ctx.impd.answers.set('/rpc/system/info', { status: 200, json: { version: '2.1.0' } });

  const port = new ImpClientPort({
    url: ctx.impd.url,
    readToken: () => 'version-token',
    now: stub.now,
  });

  const first = await port.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  stub.advance(29_999);

  const second = await port.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  expect(first).toMatchObject({ code: 'IMPD_OUTDATED' });
  expect(second).toMatchObject({ code: 'IMPD_OUTDATED' });
  expect(ctx.impd.calls).toStrictEqual([{ path: '/rpc/system/info', input: undefined }]);
});

test('it calls impd for the version again 30 seconds after its last call', async () => {
  const ctx = setupTest();
  const stub = buildStubClock(1000);

  const port = new ImpClientPort({
    url: ctx.impd.url,
    readToken: () => 'version-token',
    now: stub.now,
  });

  await port.verifyVersion();

  stub.advance(30_000);

  await port.verifyVersion();

  expect(ctx.impd.calls).toStrictEqual([
    { path: '/rpc/system/info', input: undefined },
    { path: '/rpc/system/info', input: undefined },
  ]);
});

test('it calls impd for the version again after impd refused the read before', async () => {
  const ctx = setupTest();
  const stub = buildStubClock(1000);

  const port = new ImpClientPort({
    url: ctx.impd.url,
    readToken: () => 'version-token',
    now: stub.now,
  });

  ctx.impd.answers.set('/rpc/system/info', {
    status: 503,
    json: { defined: true, code: 'UNAVAILABLE', status: 503, message: 'impd is starting' },
  });

  const refused = await port.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  ctx.impd.answers.delete('/rpc/system/info');

  await port.verifyVersion();

  expect(refused).toMatchObject({ code: 'UNAVAILABLE' });
  expect(ctx.impd.calls).toHaveLength(2);
});

test('it refuses a call as unauthorized without reaching impd when the token file is empty', () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  expect(port.verifyVersion()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
  expect(forward.ended).resolves.toMatchObject({ kind: 'failed', code: 'UNAUTHORIZED' });
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

test("it ends a guest connection relay's input after the guest's last line once impd sends the guest's eof", async () => {
  const ctx = setupTest();
  const seen: string[] = [];

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', (connection) => {
    connection.onData((data) => {
      seen.push(new TextDecoder().decode(data));
    });

    connection.onEnd(() => {
      seen.push('end');
    });
  });

  registerTestCleanup(() => {
    forward.stop();
  });

  await forward.listening;

  const [control] = ctx.impd.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(() => {
    expect(ctx.impd.relays).toHaveLength(1);
  });

  const [relay] = ctx.impd.relays;

  invariant(relay !== undefined, 'expected a relay socket');

  relay.send(new TextEncoder().encode('{"event":"Stop"}\n'));
  relay.send(JSON.stringify({ type: 'eof' }));

  await waitFor(() => {
    expect(seen).toStrictEqual(['{"event":"Stop"}\n', 'end']);
  });
});

test('it ends a reverse forward as closed with the code when impd closes its tunnel socket', async () => {
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

  const [control] = ctx.impd.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.close(4001, 'tunnel gone');

  expect(forward.ended).resolves.toStrictEqual({
    kind: 'closed',
    code: 4001,
    reason: 'tunnel gone',
  });
});

test('it writes a read-only file through impd and returns its path inside the imp', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/files/write', {
    status: 200,
    json: { path: '/run/imp/files/atc/records/s1.json' },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const path = await port.writeReadOnlyFile('imp-a', 'atc/records/s1.json', '{"revision":1}');

  expect(path).toBe('/run/imp/files/atc/records/s1.json');
});

test('it refuses a read-only file with impd’s code when the imp’s agent is too old', () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/files/write', {
    status: 409,
    json: { defined: true, code: 'AGENT_OUTDATED', status: 409, message: 'too old' },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  expect(port.writeReadOnlyFile('imp-a', 'atc/records/s1.json', '{}')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
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

test('it runs a command over an exec socket that carries the token, with no exec ticket call', async () => {
  const ctx = setupTest();

  ctx.impd.exec.reply = 'exit-early';

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'socket-token' });

  await port.runCommand('imp-a', { argv: ['true'], cwd: '/srv' });

  expect(ctx.impd.calls).toStrictEqual([]);
  expect(ctx.impd.authorizations).toStrictEqual(['Bearer socket-token']);

  expect(ctx.impd.execOpens).toStrictEqual([
    { type: 'start', name: 'imp-a', argv: ['true'], tty: false, cwd: '/srv' },
  ]);
});

test('it rejects a command as unauthorized without reaching impd when the token file is empty', () => {
  const ctx = setupTest();
  const tmp = setupTempDir('atc-imp-client-port-');
  const file = join(tmp.dir, 'token');

  writeFileSync(file, '');

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(file) });

  expect(port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  expect(ctx.impd.authorizations).toStrictEqual([]);
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

test('it closes a session connection whose gate shuts as its request goes out, sending impd nothing', async () => {
  const ctx = setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  ctx.impd.answers.set('/rpc/system/info', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execRequire: true } },
  });

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

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'closed before sending',
    closeCode: 1000,
  });

  expect(gates).toStrictEqual(['checked']);
  expect(ctx.impd.execOpens).toStrictEqual([]);
});

test('it closes a session connection whose gate throws as its request goes out, sending impd nothing', async () => {
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

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'closed before sending',
    closeCode: 1000,
  });

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

test('it sends an attach to impd without requirements, as the exec protocol of impd takes none', async () => {
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
    },
  ]);
});

test('it sends the drop of CAP_SYS_ADMIN on a start to impd', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/info', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execDropSysAdmin: true } },
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
      dropSysAdmin: true,
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
      dropSysAdmin: true,
    },
  ]);
});

test('it refuses a start that drops CAP_SYS_ADMIN on an impd without the drop, sending impd nothing', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/features', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true } },
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
      dropSysAdmin: true,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message:
      'nothing was started: this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    data: {
      reason: 'impd_outdated',
      detail:
        'this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    },
  });

  expect(ctx.impd.execOpens).toStrictEqual([]);
});

test('it never runs the gate of a start whose capability check fails, sending impd nothing', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/features', { status: 503, json: { message: 'impd is busy' } });

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
      dropSysAdmin: true,
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => {
      gates.push('checked');

      return true;
    },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: null,
    message: 'impd answered the feature check with 503; nothing was started',
  });

  expect(gates).toStrictEqual([]);
  expect(ctx.impd.execOpens).toStrictEqual([]);
});

test('it runs the gate of a start that drops CAP_SYS_ADMIN once its capability check passes', async () => {
  const ctx = setupTest();

  ctx.impd.answers.set('/rpc/system/features', {
    status: 200,
    json: { features: { sessionOffsets: true, leases: true, execDropSysAdmin: true } },
  });

  const port = new ImpClientPort({ url: ctx.impd.url, readToken: () => 'token' });

  const gates: number[] = [];

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
      dropSysAdmin: true,
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => {
      gates.push(ctx.impd.calls.length);

      return true;
    },
  );

  await connection.outcome;

  // The gate runs after the one system.features call, with the start still unsent.
  expect(gates).toStrictEqual([1]);
  expect(ctx.impd.calls).toStrictEqual([{ path: '/rpc/system/features', input: undefined }]);
  expect(ctx.impd.execOpens).toHaveLength(1);
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
