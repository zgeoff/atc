import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { isRecord } from '../shared/report';
import { ImpClientPort } from './imp-client-port';
import { readImpToken } from './read-imp-token';

// An impd stand-in on a real HTTP port that records the authorization
// header of each call and WebSocket upgrade, and the path and input of
// each RPC call. It answers a call with the answer a test set for its
// path, or else as system info, and answers a tunnel listen as listening,
// keeping that control socket so a test can announce a guest connection on
// it. It records each exec open message and refuses it as a start whose
// broker is not ready. Plus a temp directory for the token file.
function setupTest() {
  const tmp = setupTempDir('atc-imp-client-port-');
  const authorizations: (string | null)[] = [];
  const calls: { path: string; input: unknown }[] = [];

  const answers = new Map<string, { status: number; json: unknown }>();

  const controls: ServerWebSocket[] = [];
  const execOpens: unknown[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request, bunServer) => {
      authorizations.push(request.headers.get('authorization'));

      const path = new URL(request.url).pathname;

      const isUpgraded = (path === '/tunnel' || path === '/exec') && bunServer.upgrade(request);
      const text = isUpgraded ? '' : await request.text();
      const body: unknown = text === '' ? null : JSON.parse(text);

      if (!isUpgraded) {
        calls.push({ path, input: isRecord(body) ? body['json'] : undefined });
      }

      const answer = answers.get(path) ?? {
        status: 200,
        json: { features: { sessionOffsets: true, leases: true } },
      };

      return isUpgraded
        ? undefined
        : Response.json({ json: answer.json }, { status: answer.status });
    },
    websocket: {
      message: (socket, message) => {
        const parsed: unknown = JSON.parse(String(message));

        if (isRecord(parsed) && (parsed['type'] === 'start' || parsed['type'] === 'attach')) {
          execOpens.push(parsed);

          socket.send(
            JSON.stringify({
              type: 'error',
              code: 'PRECONDITION_FAILED',
              message: 'the broker is not ready',
              data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
            }),
          );
        }

        if (isRecord(parsed) && parsed['type'] === 'listen') {
          controls.push(socket);

          socket.send(
            JSON.stringify({ type: 'listening', listener: 'l1', path: '/tmp/r.sock', port: null }),
          );
        }
      },
    },
  });

  return {
    dir: tmp.dir,
    url: `http://127.0.0.1:${String(server.port)}`,
    authorizations,
    calls,
    answers,
    controls,
    execOpens,
    async [Symbol.asyncDispose]() {
      await server.stop(true);

      tmp[Symbol.dispose]();
    },
  };
}

test('it calls impd with the token its token file holds', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const features = await port.readFeatures();

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: false,
    secretRebind: false,
    execRequire: false,
  });

  expect(impd.authorizations).toStrictEqual(['Bearer file-token']);
});

test('it calls impd with the new token on the next call after the token file changes', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  await port.readFeatures();

  writeFileSync(tokenPath, 'second-token\n');

  await port.readFeatures();

  expect(impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
});

test('it refuses a call as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const refusal: unknown = await port.readFeatures().catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it ends a session connection as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const connection = port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it refuses a reverse forward as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  const refusal: unknown = await forward.listening.catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it opens a guest connection relay with the token its token file holds when the relay opens', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  onTestFinished(() => {
    forward.stop();
  });

  await forward.listening;

  writeFileSync(tokenPath, 'second-token\n');

  const [control] = impd.controls;

  if (control === undefined) {
    throw new Error('expected a tunnel control socket');
  }

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(
    () => {
      expect(impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
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
    },
  ],
])('it reads grant and exec requirement flags sent as %s as %p', async (_kind, flag, sent) => {
  await using impd = setupTest();

  impd.answers.set('/rpc/system/info', { status: 200, json: { features: sent } });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const features = await port.readFeatures();

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: flag,
    secretRebind: flag,
    execRequire: flag,
  });
});

test('it reads the caller identity impd answers tokens.whoami with', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/tokens/whoami', {
    status: 200,
    json: { kind: 'token', name: 'atc', scope: 'manage', imps: ['atc-*'], grantable: ['glm'] },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const identity = await port.readIdentity();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['/rpc/tokens/whoami']);
});

test('it reads an identity without a grantable list as one that grants nothing', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/tokens/whoami', {
    status: 200,
    json: { kind: 'token', name: 'admin', scope: 'manage', imps: null },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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
  await using impd = setupTest();

  impd.answers.set('/rpc/secrets/list', {
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

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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

test('it lists the secrets granted to the named imp', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/list', { status: 200, json: ['glm'] });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const grants = await port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
  expect(impd.calls).toStrictEqual([{ path: '/rpc/grants/list', input: { name: 'atc-s1' } }]);
});

test('it grants a secret to the named imp', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/add', { status: 200, json: {} });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  await port.createGrant('atc-s1', 'glm');

  expect(impd.calls).toStrictEqual([
    { path: '/rpc/grants/add', input: { name: 'atc-s1', secret: 'glm' } },
  ]);
});

test('it reports a revoke of a grant impd held as done', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/delete', { status: 200, json: {} });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(true);

  expect(impd.calls).toStrictEqual([
    { path: '/rpc/grants/delete', input: { name: 'atc-s1', secret: 'glm' } },
  ]);
});

test('it reports a revoke of a grant impd no longer holds as nothing removed', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/delete', {
    status: 404,
    json: {
      defined: true,
      code: 'NOT_FOUND',
      status: 404,
      message: 'Not found',
      data: { kind: 'grant', name: 'atc-s1/glm' },
    },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const removed = await port.removeGrant('atc-s1', 'glm');

  expect(removed).toBe(false);
});

test('it rejects a revoke on an imp impd does not hold', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/delete', {
    status: 404,
    json: {
      defined: true,
      code: 'NOT_FOUND',
      status: 404,
      message: 'Not found',
      data: { kind: 'imp', name: 'atc-s1' },
    },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const refusal: unknown = await port.removeGrant('atc-s1', 'glm').catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'atc-s1' },
  });
});

test('it rejects a revoke impd forbids with its reason', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/grants/delete', {
    status: 403,
    json: {
      defined: true,
      code: 'FORBIDDEN',
      status: 403,
      message: 'Forbidden',
      data: { reason: 'not_grantable' },
    },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

  const refusal: unknown = await port.removeGrant('atc-s1', 'glm').catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it reads the id of the imp under a name', async () => {
  await using impd = setupTest();

  impd.answers.set('/rpc/imps/get', {
    status: 200,
    json: { id: '0199a1b2-0000-7000-8000-000000000001', name: 'atc-s1', state: 'sleeping' },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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
  await using impd = setupTest();

  impd.answers.set('/rpc/imps/create', {
    status: 200,
    json: { id: '0199a1b2-0000-7000-8000-000000000002', name: 'atc-s2', state: 'creating' },
  });

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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
  await using impd = setupTest();

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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
  );

  const outcome = await connection.outcome;

  expect({ opens: impd.execOpens, outcome }).toStrictEqual({
    opens: [
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
        require: ['broker'],
      },
    ],
    outcome: {
      kind: 'failed',
      code: 'PRECONDITION_FAILED',
      message: 'the broker is not ready',
      data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
    },
  });
});

test('it closes a session connection whose gate shuts as it opens, sending impd nothing', async () => {
  await using impd = setupTest();

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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

  expect({ gates, opens: impd.execOpens }).toStrictEqual({ gates: ['checked'], opens: [] });
});

test('it sends the request of a session connection whose gate stays open as it opens', async () => {
  await using impd = setupTest();

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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

  await connection.outcome;

  expect(impd.execOpens).toMatchObject([{ type: 'start', name: 'atc-s1' }]);
});

test('it sends the requirements of an attach to impd', async () => {
  await using impd = setupTest();

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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

  expect(impd.execOpens).toStrictEqual([
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
  await using impd = setupTest();

  const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

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

  expect(impd.execOpens).toStrictEqual([
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
