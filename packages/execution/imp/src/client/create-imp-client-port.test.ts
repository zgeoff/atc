import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { TEST_TOKEN, startTestImpd } from '@impz/testing';
import type { TestImpdOptions } from '@impz/testing';
import invariant from 'tiny-invariant';
import { readImpToken } from '../auth/read-imp-token';
import { buildMockImpSessionRequest } from '../test-utils/build-mock-imp-session-request';
import { startStubImpdSockets } from '../test-utils/start-stub-impd-sockets';
import { startStubStallingProxy } from '../test-utils/start-stub-stalling-proxy';
import { createImpClientPort } from './create-imp-client-port';

// The impd answers through its fault proxy, which records each call. The
// sockets stand-in answers impd's exec and tunnel sockets, which the test impd
// cannot, and sends every other request to the impd.
async function setupTest(options: TestImpdOptions = {}) {
  const impd = await startTestImpd(options);

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');

  const sockets = startStubImpdSockets({ upstreamUrl: impd.url });

  return { impd, sockets };
}

test('it calls impd with the token its token file holds', async () => {
  const ctx = await setupTest();
  const token = await ctx.impd.client.tokens.create({ name: 'file', scope: 'manage' });

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, `${token.secret}\n`);

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  await port.verifyVersion();

  expect(ctx.impd.calls.slice(arranged).map((call) => call.authorization)).toStrictEqual([
    `Bearer ${token.secret}`,
  ]);
});

test('it calls impd with the new token on the next call after the token file changes', async () => {
  const ctx = await setupTest();
  const first = await ctx.impd.client.tokens.create({ name: 'first', scope: 'manage' });
  const second = await ctx.impd.client.tokens.create({ name: 'second', scope: 'manage' });

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, `${first.secret}\n`);

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  await port.verifyVersion();

  writeFileSync(tokenPath, `${second.secret}\n`);

  await port.verifyVersion();

  expect(ctx.impd.calls.slice(arranged).map((call) => call.authorization)).toStrictEqual([
    `Bearer ${first.secret}`,
    `Bearer ${second.secret}`,
  ]);
});

test.each(['2.2.0', '2.7.0'])('it accepts impd %s', async (version) => {
  const ctx = await setupTest({ version });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.verifyVersion()).toResolve();
});

test('it refuses impd 2.1.0 as outdated, naming both versions', async () => {
  const ctx = await setupTest({ version: '2.1.0' });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.verifyVersion()).rejects.toMatchObject({
    code: 'IMPD_OUTDATED',
    message: 'impd 2.1.0 is older than 2.2.0, the oldest impd this atc supports',
    data: { version: '2.1.0', minimum: '2.2.0' },
  });
});

test('it refuses an impd whose version does not parse as outdated', async () => {
  const ctx = await setupTest({ version: 'nightly' });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.verifyVersion()).rejects.toMatchObject({
    code: 'IMPD_OUTDATED',
    message:
      "impd reports version 'nightly', which atc cannot compare with 2.2.0, the oldest impd this atc supports",
    data: { version: 'nightly', minimum: '2.2.0' },
  });
});

test('it reads the guest scratch folder impd declares', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const scratchDir = await port.readGuestScratchDir();

  expect(scratchDir).toBe('/tmp');
});

test('it refuses the guest scratch folder of an impd that declares none as outdated', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('system/info', { status: 200, body: { json: { version: '2.5.0' } } });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.readGuestScratchDir()).rejects.toMatchObject({
    code: 'IMPD_OUTDATED',
    message:
      "impd 2.5.0 declares no guest scratch folder; upgrade impd, or set the target's guestDir",
    data: { version: '2.5.0' },
  });
});

test('it answers a version check and a scratch folder read within 30 seconds with its one call to impd', async () => {
  const ctx = await setupTest();

  const stub = buildStubClock(1000);

  const port = createImpClientPort({
    url: ctx.impd.url,
    readToken: () => TEST_TOKEN,
    clock: stub,
  });

  await port.verifyVersion();

  stub.advance(29_999);

  await port.readGuestScratchDir();

  expect(ctx.impd.calls.map((call) => call.procedure)).toStrictEqual(['system/info']);
});

test('it answers the version checks within 30 seconds of a read with its one call to impd', async () => {
  const ctx = await setupTest();

  const stub = buildStubClock(1000);

  const port = createImpClientPort({
    url: ctx.impd.url,
    readToken: () => TEST_TOKEN,
    clock: stub,
  });

  await Promise.all([port.verifyVersion(), port.verifyVersion()]);

  stub.advance(29_999);

  await port.verifyVersion();

  expect(ctx.impd.calls.map((call) => call.procedure)).toStrictEqual(['system/info']);
});

test('it refuses an outdated impd again within 30 seconds from its one call to impd', async () => {
  const ctx = await setupTest({ version: '2.1.0' });

  const stub = buildStubClock(1000);

  const port = createImpClientPort({
    url: ctx.impd.url,
    readToken: () => TEST_TOKEN,
    clock: stub,
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
  expect(ctx.impd.calls.map((call) => call.procedure)).toStrictEqual(['system/info']);
});

test('it calls impd for the version again 30 seconds after its last call', async () => {
  const ctx = await setupTest();

  const stub = buildStubClock(1000);

  const port = createImpClientPort({
    url: ctx.impd.url,
    readToken: () => TEST_TOKEN,
    clock: stub,
  });

  await port.verifyVersion();

  stub.advance(30_000);

  await port.verifyVersion();

  expect(ctx.impd.calls.map((call) => call.procedure)).toStrictEqual([
    'system/info',
    'system/info',
  ]);
});

test('it calls impd for the version again after impd refused the read before', async () => {
  const ctx = await setupTest();

  const stub = buildStubClock(1000);

  const port = createImpClientPort({
    url: ctx.impd.url,
    readToken: () => TEST_TOKEN,
    clock: stub,
  });

  ctx.impd.fail(
    'system/info',
    { code: 'UNAVAILABLE', status: 503, message: 'impd is starting' },
    { times: 1 },
  );

  const refused = await port.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  await port.verifyVersion();

  expect(refused).toMatchObject({ code: 'UNAVAILABLE' });
  expect(ctx.impd.calls).toHaveLength(2);
});

test('it refuses a call as unauthorized without reaching impd when the token file is empty', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => readImpToken(tokenPath) });

  await expect(port.verifyVersion()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

  expect(ctx.impd.calls).toStrictEqual([]);
});

test('it ends a session connection as unauthorized without reaching impd when the token file is empty', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = createImpClientPort({
    url: ctx.sockets.url,
    readToken: () => readImpToken(tokenPath),
  });

  const connection = port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
  expect(ctx.sockets.authorizations).toStrictEqual([]);
});

test('it refuses a reverse forward as unauthorized without reaching impd when the token file is empty', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = createImpClientPort({
    url: ctx.sockets.url,
    readToken: () => readImpToken(tokenPath),
  });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  expect(forward.listening).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(forward.ended).resolves.toMatchObject({ kind: 'failed', code: 'UNAUTHORIZED' });
  expect(ctx.sockets.authorizations).toStrictEqual([]);
});

test('it opens a guest connection relay with the token its token file holds when the relay opens', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = createImpClientPort({
    url: ctx.sockets.url,
    readToken: () => readImpToken(tokenPath),
  });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  registerTestCleanup(() => {
    forward.stop();
  });

  await forward.listening;

  writeFileSync(tokenPath, 'second-token\n');

  const [control] = ctx.sockets.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(
    () => {
      expect(ctx.sockets.authorizations).toStrictEqual([
        'Bearer first-token',
        'Bearer second-token',
      ]);
    },
    { timeoutMs: 2000 },
  );
});

test("it ends a guest connection relay's input after the guest's last line once impd sends the guest's eof", async () => {
  const ctx = await setupTest();

  const seen: string[] = [];
  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => 'token' });

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

  const [control] = ctx.sockets.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(() => {
    expect(ctx.sockets.relays).toHaveLength(1);
  });

  const [relay] = ctx.sockets.relays;

  invariant(relay !== undefined, 'expected a relay socket');

  relay.send(new TextEncoder().encode('{"event":"Stop"}\n'));
  relay.send(JSON.stringify({ type: 'eof' }));

  await waitFor(() => {
    expect(seen).toStrictEqual(['{"event":"Stop"}\n', 'end']);
  });
});

test('it ends a reverse forward as closed with the code when impd closes its tunnel socket', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const tokenPath = join(temporaryDirectory.path, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = createImpClientPort({
    url: ctx.sockets.url,
    readToken: () => readImpToken(tokenPath),
  });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  registerTestCleanup(() => {
    forward.stop();
  });

  await forward.listening;

  const [control] = ctx.sockets.controls;

  invariant(control !== undefined, 'expected a tunnel control socket');

  control.close(4001, 'tunnel gone');

  expect(forward.ended).resolves.toStrictEqual({
    kind: 'closed',
    code: 4001,
    reason: 'tunnel gone',
  });
});

test('it ends a reverse forward as closed once its path to impd stays silent for 30 seconds', async () => {
  const ctx = await setupTest();

  const proxy = startStubStallingProxy(Number(new URL(ctx.sockets.url).port));
  const clock = buildStubClock(0);

  const port = createImpClientPort({
    url: `http://127.0.0.1:${String(proxy.port)}`,
    readToken: () => 'token',
    clock,
  });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  registerTestCleanup(() => {
    forward.stop();
  });

  await forward.listening;

  proxy.stall();
  clock.advance(30_000);

  expect(forward.ended).resolves.toStrictEqual({
    kind: 'closed',
    code: 1006,
    reason: '',
  });
});

test('it writes a read-only file through impd and returns its path inside the imp', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('files/write', {
    status: 200,
    body: { json: { path: '/run/imp/files/atc/records/s1.json' } },
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const path = await port.writeReadOnlyFile('imp-a', 'atc/records/s1.json', '{"revision":1}');

  expect(path).toBe('/run/imp/files/atc/records/s1.json');
});

test('it refuses a read-only file with impd’s code when the imp’s agent is too old', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('files/write', { code: 'AGENT_OUTDATED', status: 409, message: 'too old' });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.writeReadOnlyFile('imp-a', 'atc/records/s1.json', '{}')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
  });
});

test('it sends a command stdin larger than one WebSocket message impd takes', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const file = join(temporaryDirectory.path, 'token');

  writeFileSync(file, 't0');

  ctx.sockets.exec.reply = 'count';

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => readImpToken(file) });

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
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const file = join(temporaryDirectory.path, 'token');

  writeFileSync(file, 't0');

  ctx.sockets.exec.reply = 'exit-early';

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => readImpToken(file) });

  const result = await port.runCommand('imp-a', {
    argv: ['false'],
    stdin: new Uint8Array(5 * 1024 * 1024),
  });

  expect(result.code).toBe(2);
});

test('it runs a command over an exec socket that carries the token, with no exec ticket call', async () => {
  const ctx = await setupTest();

  ctx.sockets.exec.reply = 'exit-early';

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => 'socket-token' });

  await port.runCommand('imp-a', { argv: ['true'], cwd: '/srv' });

  expect(ctx.impd.calls).toStrictEqual([]);
  expect(ctx.sockets.authorizations).toStrictEqual(['Bearer socket-token']);

  expect(ctx.sockets.execOpens).toStrictEqual([
    { type: 'start', name: 'imp-a', argv: ['true'], tty: false, cwd: '/srv' },
  ]);
});

test('it rejects a command as unauthorized without reaching impd when the token file is empty', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-imp-client-port-');
  const file = join(temporaryDirectory.path, 'token');

  writeFileSync(file, '');

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => readImpToken(file) });

  await expect(port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  expect(ctx.sockets.authorizations).toStrictEqual([]);
});

test('it rejects a command whose start impd refuses with the refusal', async () => {
  const ctx = await setupTest();

  ctx.impd.refuseExec({
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('it reads the caller identity impd answers tokens.whoami with', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  const token = await ctx.impd.client.tokens.create({
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => token.secret });

  const identity = await port.readIdentity();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  expect(ctx.impd.calls.slice(arranged).map((call) => call.procedure)).toStrictEqual([
    'tokens/whoami',
  ]);
});

test('it reads an identity without a grantable list as one that grants nothing', async () => {
  const ctx = await setupTest();

  // An impd from before grantable lists answers none, which a current impd never does.
  ctx.impd.fail('tokens/whoami', {
    status: 200,
    body: { json: { kind: 'token', name: 'admin', scope: 'manage', imps: null } },
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

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
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'reg',
    value: 'reg-value',
    rules: [{ host: 'reg.example.com', header: 'authorization', scheme: 'basic', user: 'bot' }],
  });

  await ctx.impd.client.grants.add({ name: 'atc-s1', secret: 'glm' });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const secrets = await port.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'glm',
      kind: 'static',
      rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      imps: ['atc-s1'],
    },
    {
      name: 'reg',
      kind: 'static',
      rules: [{ host: 'reg.example.com', header: 'authorization', scheme: 'basic', user: 'bot' }],
      imps: [],
    },
  ]);
});

test('it lists an oauth secret with its sign-in status and ID token claims', async () => {
  const ctx = await setupTest();

  // A sign-in needs the identity provider's token endpoint, which the test impd cannot reach.
  ctx.impd.fail('secrets/list', {
    status: 200,
    body: {
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
    },
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

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
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  await ctx.impd.client.grants.add({ name: 'atc-s1', secret: 'glm' });

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const grants = await port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);

  expect(
    ctx.impd.calls
      .slice(arranged)
      .map((call) => ({ procedure: call.procedure, input: call.input })),
  ).toStrictEqual([{ procedure: 'grants/list', input: { name: 'atc-s1' } }]);
});

test('it grants a secret to the named imp', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await port.createGrant('atc-s1', 'glm');

  expect(
    ctx.impd.calls
      .slice(arranged)
      .map((call) => ({ procedure: call.procedure, input: call.input })),
  ).toStrictEqual([{ procedure: 'grants/add', input: { name: 'atc-s1', secret: 'glm' } }]);

  const granted = await ctx.impd.client.grants.list({ name: 'atc-s1' });

  expect(granted).toStrictEqual(['glm']);
});

test('it reports a revoke of a grant impd held as done', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  await ctx.impd.client.grants.add({ name: 'atc-s1', secret: 'glm' });

  const arranged = ctx.impd.calls.length;
  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(true);

  expect(
    ctx.impd.calls
      .slice(arranged)
      .map((call) => ({ procedure: call.procedure, input: call.input })),
  ).toStrictEqual([{ procedure: 'grants/delete', input: { name: 'atc-s1', secret: 'glm' } }]);
});

test('it reports a revoke of a grant impd no longer holds as nothing removed', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(false);
});

test('it rejects a revoke on an imp impd does not hold', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await expect(port.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'atc-s1' },
  });
});

test('it rejects a revoke impd forbids with its reason', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  await ctx.impd.client.secrets.add({
    kind: 'static',
    name: 'glm',
    value: 'glm-value',
    rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
  });

  const token = await ctx.impd.client.tokens.create({
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
  });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => token.secret });

  await expect(port.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it reads the id of the imp under a name', async () => {
  const ctx = await setupTest();
  const created = await ctx.impd.client.imps.create({ name: 'atc-s1', image: 'ubuntu' });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const imp = await port.readImp('atc-s1');

  expect(imp).toStrictEqual({
    id: created.id,
    name: 'atc-s1',
    state: created.state,
    leases: [],
    otherLeaseCount: 0,
  });
});

test('it reads the id of the imp it creates', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const imp = await port.createImp({ name: 'atc-s2' });
  const held = await ctx.impd.client.imps.get({ name: 'atc-s2' });

  expect(imp).toStrictEqual({
    id: held.id,
    name: 'atc-s2',
    state: held.state,
    leases: [],
    otherLeaseCount: 0,
  });
});

test("it sends impd the new imp's memory and memory max", async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  await port.createImp({ name: 'atc-s3', memoryMib: 1024, maxMemoryMib: 2048 });

  expect(ctx.impd.calls).toContainEqual({
    procedure: 'imps/create',
    input: { name: 'atc-s3', memoryMib: 1024, maxMemoryMib: 2048 },
    authorization: `Bearer ${TEST_TOKEN}`,
  });
});

test('it sends the requirements of a start to impd and ends the connection with its refusal', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });
  const request = buildMockImpSessionRequest({ require: ['broker'] });
  const connection = port.openSession(request, { onStarted: () => {}, onOutput: () => {} });

  const outcome = await connection.outcome;

  expect(ctx.sockets.execOpens).toStrictEqual([
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
  const ctx = await setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });
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
  expect(ctx.sockets.execOpens).toStrictEqual([]);
});

test('it closes a session connection whose gate throws as its request goes out, sending impd nothing', async () => {
  const ctx = await setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(ctx.sockets.execOpens).toStrictEqual([]);
});

test('it sends the request of a session connection whose gate stays open as it opens', async () => {
  const ctx = await setupTest();

  // The client asks impd whether it checks exec requirements before a
  // start that requires one.
  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  expect(ctx.sockets.execOpens).toStrictEqual([
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
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(ctx.sockets.execOpens).toStrictEqual([
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

test('it ends a session connection as closed once its path to impd stays silent for 30 seconds', async () => {
  const ctx = await setupTest();

  ctx.sockets.exec.reply = 'count';

  const proxy = startStubStallingProxy(Number(new URL(ctx.sockets.url).port));
  const clock = buildStubClock(0);

  const port = createImpClientPort({
    url: `http://127.0.0.1:${String(proxy.port)}`,
    readToken: () => TEST_TOKEN,
    clock,
  });

  const started = Promise.withResolvers<void>();

  const connection = port.openSession(
    { kind: 'attach', name: 'atc-s1', session: 'atc-s1', cols: 80, rows: 24, wake: false },
    {
      onStarted: () => {
        started.resolve();
      },
      onOutput: () => {},
    },
  );

  await started.promise;

  proxy.stall();
  connection.resize(120, 40);
  clock.advance(30_000);

  expect(connection.outcome).resolves.toStrictEqual({
    kind: 'closed',
    reason: 'code 1006',
    closeCode: 1006,
  });
});

test('it sends the drop of CAP_SYS_ADMIN on a start to impd', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(ctx.sockets.execOpens).toStrictEqual([
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
  const ctx = await setupTest({ features: { execDropSysAdmin: false } });

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(ctx.sockets.execOpens).toStrictEqual([]);
});

test('it never runs the gate of a start whose capability check fails, sending impd nothing', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('system/features', { status: 503, body: { message: 'impd is busy' } });

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });
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
  expect(ctx.sockets.execOpens).toStrictEqual([]);
});

test('it runs the gate of a start that drops CAP_SYS_ADMIN once its capability check passes', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });
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

  expect(gates).toStrictEqual([1]);
  expect(ctx.impd.calls.map((call) => call.procedure)).toStrictEqual(['system/features']);
  expect(ctx.sockets.execOpens).toHaveLength(1);
});

test('it sends a start without requirements when the request holds none', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.sockets.url, readToken: () => TEST_TOKEN });

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

  expect(ctx.sockets.execOpens).toStrictEqual([
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

test("it reads impd's identity issuer from the status report", async () => {
  const ctx = await setupTest({ env: { IMP_IDENTITY_ISSUER: 'impd.example.test' } });

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const issuer = await port.readIssuer();

  expect(issuer).toBe('impd.example.test');
});

test('it reads no issuer while impd has identity off', async () => {
  const ctx = await setupTest();

  const port = createImpClientPort({ url: ctx.impd.url, readToken: () => TEST_TOKEN });

  const issuer = await port.readIssuer();

  expect(issuer).toBeNull();
});
