import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCuttingStreamProxy } from '@atc/app/test-utils/start-cutting-stream-proxy';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { readJSONRecord } from '@atc/core/test-utils/read-json-record';
import { resolveGatewayCommand } from '@atc/core/test-utils/resolve-gateway-command';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { createDaemonClient } from '@atc/protocol/client';
import { connectGateway } from '@atcx/client/gateway';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import invariant from 'tiny-invariant';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-gateway-rpc-');
  const directory = temporaryDirectory.path;
  const daemonToken = randomBytes(16).toString('hex');
  const fullToken = `atcs_${randomBytes(24).toString('hex')}`;
  const limitedToken = `atcs_${randomBytes(24).toString('hex')}`;

  writeFileSync(join(directory, 'daemon-token'), `${daemonToken}\n`);

  const daemon = await startTestDaemon({
    prefix: 'atc-gateway-rpc-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      principals: new Map([
        ['service:ci', ['local']],
        ['service:limited', ['local']],
      ]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(directory, 'daemon-token') },
    }),
  });

  const prober = createDaemonClient(daemon.socketPath);

  registerTestCleanup(() => {
    prober.stop();
  });

  const hello = await prober.sendHello(daemon.build);

  writeFileSync(
    join(directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: {
          address: `127.0.0.1:${daemon.daemon.listenPort}`,
          daemonID: String(hello['daemonID']),
        },
      },
      defaultDaemon: 'cloud',
    }),
  );

  writeFileSync(
    join(directory, 'service-tokens.json'),
    JSON.stringify({
      resource: 'https://atc.example.com/mcp',
      clients: {
        ci: { scopes: ['read', 'message', 'spawn', 'kill'], tokens: [fullToken] },
        limited: { scopes: ['read', 'message', 'spawn'], tokens: [limitedToken] },
      },
    }),
    { mode: 0o600 },
  );

  const gateway = Bun.spawn(
    [
      ...resolveGatewayCommand(process.env['ATC_GATEWAY_BIN']),
      '--state-dir',
      'state',
      'serve',
      '--public-url',
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--port',
      '0',
      '--service-token-file',
      'service-tokens.json',
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: join(directory, 'home'),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        ATC_GATEWAY_TOKEN_CLOUD: daemonToken,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  registerTestCleanup(() => {
    gateway.kill();

    return gateway.exited;
  });

  const reader = gateway.stdout.getReader();

  const chunk = await reader.read();

  reader.releaseLock();

  const serving = new TextDecoder().decode(chunk.value);

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)\n$/u.exec(serving)?.groups?.[
    'port'
  ];

  invariant(port !== undefined, `no bound port in the serving line: ${serving}`);

  return { directory, url: `http://127.0.0.1:${port}`, fullToken, limitedToken };
}

test('it spawns with a key, submits, reads the screen, sends a message and kills through the client', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.fullToken });

  const spawned = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'job-1-spawn' });
  const replayed = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'job-1-spawn' });

  await atc.session.submit({ session: spawned.session.id, text: 'run the tests again' });

  const screen = await atc.session.screen({ session: spawned.session.id });

  const sent = await atc.session.message({
    session: spawned.session.id,
    text: 'status?',
    idempotencyKey: 'job-1-message',
  });

  const killed = await atc.session.kill({ session: spawned.session.id });
  const listed = await atc.session.list({});

  expect({
    id: spawned.session.id,
    replayedID: replayed.session.id,
    hasScreen: typeof screen.text,
    messageID: typeof sent.message,
    killed: killed.stopped,
    kept: listed.sessions.map((session) => session.id),
  }).toStrictEqual({
    id: expect.toStartWith('cloud.'),
    replayedID: spawned.session.id,
    hasScreen: 'string',
    messageID: 'string',
    killed: true,
    kept: [spawned.session.id],
  });
});

test('it reads events.stream from a saved cursor and resumes after the last event it saw', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.fullToken });

  const spawned = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'stream-spawn' });
  const head = await atc.events.read({});

  await atc.session.message({ session: spawned.session.id, text: 'one', idempotencyKey: 'm1' });
  await atc.session.message({ session: spawned.session.id, text: 'two', idempotencyKey: 'm2' });

  const first = await atc.events.stream({ cursor: head.cursor });

  const cursors: string[] = [];

  for await (const item of first) {
    if (item.kind === 'event') {
      cursors.push(item.event.cursor);
    }

    if (cursors.length === 2) {
      break;
    }
  }

  const [saved] = cursors;

  const resumed = await atc.events.stream({ cursor: saved });

  const afterSaved: string[] = [];

  for await (const item of resumed) {
    if (item.kind === 'event') {
      afterSaved.push(item.event.cursor);
    }

    if (afterSaved.length === 1) {
      break;
    }
  }

  expect(afterSaved).toStrictEqual(cursors.slice(1));
});

test('it reconnects a cut stream with its last event id and a new token, and loses and repeats no event', async () => {
  const ctx = await setupTest();

  const plain = connectGateway({ url: ctx.url, token: ctx.fullToken });

  const spawned = await plain.session.spawn({ cwd: ctx.directory, idempotencyKey: 'cut-spawn' });
  const head = await plain.events.read({});

  await plain.session.message({ session: spawned.session.id, text: 'one', idempotencyKey: 'c1' });
  await plain.session.message({ session: spawned.session.id, text: 'two', idempotencyKey: 'c2' });
  await plain.session.message({ session: spawned.session.id, text: 'three', idempotencyKey: 'c3' });

  const truth = await plain.events.read({ cursor: head.cursor, limit: 200 });

  const expected = truth.events.map((event) => event.cursor);
  const proxy = startCuttingStreamProxy(ctx.url);

  registerTestCleanup(() => proxy.stop());

  let tokenCalls = 0;

  const atc = connectGateway({
    url: proxy.url,
    token: () => {
      tokenCalls += 1;

      return ctx.fullToken;
    },
  });

  const stream = await atc.events.stream({ cursor: head.cursor });

  const seen: string[] = [];

  for await (const item of stream) {
    if (item.kind === 'event') {
      seen.push(item.event.cursor);
    }

    if (seen.length === expected.length) {
      break;
    }
  }

  expect({
    seen,
    streamRequests: proxy.streamRequests,
    resumedAfter: proxy.streamRequests[1] === seen[0],
    tokenCalls: tokenCalls >= 2,
  }).toStrictEqual({
    seen: expected,
    streamRequests: [null, seen[0] ?? null],
    resumedAfter: true,
    tokenCalls: true,
  });
});

test('it refuses a kill with insufficient_scope for a token without the kill scope', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.limitedToken });

  const spawned = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'scope-spawn' });

  const killed = atc.session.kill({ session: spawned.session.id });

  expect(killed).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['kill'] },
  });
});

test('it answers protocol_mismatch with the gateway major for a client built against another major', async () => {
  const ctx = await setupTest();

  const response = await fetch(`${ctx.url}/rpc/dirs/list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.fullToken}`,
      'x-atc-major': String(CONTRACT_MAJOR - 1),
    },
    body: JSON.stringify({ json: {} }),
  });

  const body = await readJSONRecord(response);

  expect(body['json']).toMatchObject({
    code: 'protocol_mismatch',
    data: { gatewayMajor: CONTRACT_MAJOR },
  });
});

test('it answers 401 for a token the gateway does not know', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: `atcs_${'z'.repeat(40)}` });
  const listed = atc.dirs.list({});

  expect(listed).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});
