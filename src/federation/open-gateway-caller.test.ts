import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { openMCPAuth } from '../mcp/open-mcp-auth';
import { startMCPHTTPServer } from '../mcp/start-mcp-http-server';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubTimeoutScheduler } from '../test-utils/build-stub-timeout-scheduler';
import { readJSONRecord } from '../test-utils/read-json-record';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { sendMCPRequest } from '../test-utils/send-mcp-request';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { openGatewayCaller } from './open-gateway-caller';

/**
 * The gateway's caller behind the MCP HTTP server, as the gateway entrypoint
 * wires them, in front of two real daemons, `cloud` (the default) and
 * `pc`, each listening on a loopback TCP port for the gateway's token, read
 * from `cloud-token` and `pc-token` in `dir`, with a principals key that
 * lets the OAuth client `Claude` use the local target. `claudeToken` is an
 * access token of `Claude`, and `strangerToken` one of `Stranger`, a client
 * no daemon lists. `timers` starts every timer of the gateway's daemon
 * connections, so none runs unless a test runs it. Sessions run in `dir`.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-'));
  const authDBPath = join(tmp.dir, 'mcp-auth.db');

  const auth = await openMCPAuth({ dbPath: authDBPath, origin: null });

  stack.defer(() => auth.close());

  // The redirect URI both clients register and their code flows use.
  const redirectURI = 'https://claude.ai/api/mcp/auth_callback';

  const claude = await auth.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: [redirectURI] },
  });

  const stranger = await auth.auth.api.createFixedClient({
    body: { name: 'Stranger', redirectURIs: [redirectURI] },
  });

  // The token both listeners take, which the gateway presents. Each daemon
  // reads it from a file of its own, so a test can change one daemon's.
  const token = randomBytes(16).toString('hex');

  writeFileSync(join(tmp.dir, 'cloud-token'), `${token}\n`);
  writeFileSync(join(tmp.dir, 'pc-token'), `${token}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-gateway-cloud-',
    options: () => ({
      // Session messages need an adapter that takes them.
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      principals: new Map([[claude.clientID, ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'cloud-token') },
    }),
  });

  stack.use(cloud);

  const pc = await startTestDaemon({
    prefix: 'atc-gateway-pc-',
    options: () => ({
      // Session messages need an adapter that takes them.
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      principals: new Map([[claude.clientID, ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'pc-token') },
    }),
  });

  stack.use(pc);

  const cloudProber = await DaemonClient.open(cloud.socketPath);

  stack.defer(() => {
    cloudProber.stop();
  });

  const pcProber = await DaemonClient.open(pc.socketPath);

  stack.defer(() => {
    pcProber.stop();
  });

  const cloudHello = await cloudProber.sendHello(cloud.build);
  const pcHello = await pcProber.sendHello(pc.build);

  const cloudID = String(cloudHello['daemonID']);
  const pcID = String(pcHello['daemonID']);
  const timers = buildStubTimeoutScheduler();

  const gateway = openGatewayCaller({
    registry: {
      daemons: new Map([
        [
          'cloud',
          {
            name: 'cloud',
            address: { host: '127.0.0.1', port: Number(cloud.daemon.listenPort) },
            daemonID: cloudID,
            incarnation: cloudID.slice(0, 8),
            token,
          },
        ],
        [
          'pc',
          {
            name: 'pc',
            address: { host: '127.0.0.1', port: Number(pc.daemon.listenPort) },
            daemonID: pcID,
            incarnation: pcID.slice(0, 8),
            token,
          },
        ],
      ]),
      defaultDaemon: 'cloud',
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
    gatewayDBPath: join(tmp.dir, 'gateway.db'),
    fanOutTimeoutMs: 1000,
    scheduleTimeout: timers.schedule,
  });

  stack.defer(() => gateway.stop());

  const approvals: string[] = [];

  const server = await startMCPHTTPServer({
    caller: gateway.caller,
    build: 'atc-gateway/test',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    dbPath: authDBPath,
    printApproval: (line) => {
      approvals.push(line);
    },
    printRequest: () => {},
    probes: true,
  });

  stack.defer(() => server.stop());

  const accessTokens = new Map<string, string>();

  for (const clientID of [claude.clientID, stranger.clientID]) {
    const authorized = await runMCPAuthorization(
      { url: server.url, origin: server.origin, approvals },
      {
        clientID,
        redirectURI,
        scope: 'read message spawn kill',
        ticked: ['read', 'message', 'spawn', 'kill'],
      },
    );

    const exchanged = await fetch(`${server.url}/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorized.code,
        redirect_uri: redirectURI,
        client_id: clientID,
        code_verifier: authorized.verifier,
        resource: `${server.origin}/mcp`,
      }),
    });

    const tokens = await readJSONRecord(exchanged);

    accessTokens.set(clientID, String(tokens['access_token']));
  }

  const owned = stack.move();

  return {
    url: server.url,
    dir: tmp.dir,
    cloud,
    pc,
    cloudID,
    pcID,
    timers,
    claudeToken: String(accessTokens.get(claude.clientID)),
    strangerToken: String(accessTokens.get(stranger.clientID)),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it lists the sessions of both daemons under gateway ids with each daemon up', async () => {
  await using ctx = await setupTest();

  await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, name: 'on-cloud' },
  });

  await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, name: 'on-pc', daemon: 'pc' },
  });

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_list',
    arguments: {},
  });

  const structured = getRecord(listed, 'structuredContent');
  const cloudPrefix = `cloud.${ctx.cloudID.slice(0, 8)}.`;
  const pcPrefix = `pc.${ctx.pcID.slice(0, 8)}.`;

  expect(structured['sessions']).toStrictEqual([
    expect.objectContaining({ id: expect.toStartWith(cloudPrefix), name: 'on-cloud' }),
    expect.objectContaining({ id: expect.toStartWith(pcPrefix), name: 'on-pc' }),
  ]);

  expect(structured['daemons']).toStrictEqual([
    { name: 'cloud', state: 'up' },
    { name: 'pc', state: 'up' },
  ]);
});

test('it reads a session through its gateway id from the daemon that holds it', async () => {
  await using ctx = await setupTest();

  const spawned = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, name: 'on-pc', daemon: 'pc' },
  });

  const id = String(getRecord(spawned, 'structuredContent')['id']);

  const got = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_get',
    arguments: { session: id },
  });

  expect(getRecord(getRecord(got, 'structuredContent'), 'session')).toMatchObject({
    id,
    name: 'on-pc',
  });

  expect(ctx.pc.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.objectContaining({ id: id.split('.').at(-1), name: 'on-pc' })],
  });
});

test('it replays a keyed spawn from the daemon the key was bound to when the retry leaves the daemon out', async () => {
  await using ctx = await setupTest();

  const first = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, name: 'keyed', daemon: 'pc', idempotencyKey: 'spawn-once' },
  });

  const retried = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, name: 'keyed', idempotencyKey: 'spawn-once' },
  });

  expect(getRecord(retried, 'structuredContent')['id']).toBe(
    getRecord(first, 'structuredContent')['id'],
  );

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });

  expect(ctx.pc.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it reads the events of both daemons in one page', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const ids = spawns.map((spawned) => String(getRecord(spawned, 'structuredContent')['id']));

  await Promise.all(
    ids.map((session) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_message',
        arguments: { session, text: `hello ${session}` },
      }),
    ),
  );

  const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: {},
  });

  const page = getRecord(read, 'structuredContent');

  expect(page['events']).toIncludeAllPartialMembers(
    ids.map((session) => ({ kind: 'message-accepted', session })),
  );

  expect(page['unavailable']).toStrictEqual([]);
});

test('it resumes an events read after the events of its page', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const ids = spawns.map((spawned) => String(getRecord(spawned, 'structuredContent')['id']));

  await Promise.all(
    ids.map((session) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_message',
        arguments: { session, text: `hello ${session}` },
      }),
    ),
  );

  const first = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: {},
  });

  await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_message',
    arguments: { session: ids[1], text: 'later' },
  });

  const next = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: getRecord(first, 'structuredContent')['cursor'] },
  });

  expect(getRecord(next, 'structuredContent')['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-accepted', session: ids[1] }),
  ]);
});

test('it shows a stopped daemon as down', async () => {
  await using ctx = await setupTest();

  await ctx.pc.stop();

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_list',
    arguments: {},
  });

  expect(getRecord(listed, 'structuredContent')['daemons']).toStrictEqual([
    { name: 'cloud', state: 'up' },
    { name: 'pc', state: 'down' },
  ]);
});

test('it refuses a spawn on a stopped daemon as daemon_unavailable', async () => {
  await using ctx = await setupTest();

  await ctx.pc.stop();

  const refused = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, daemon: 'pc' },
  });

  expect(refused).toStrictEqual({
    content: [{ type: 'text', text: "daemon_unavailable: daemon 'pc' is unreachable" }],
    isError: true,
  });
});

test('it answers daemon_unauthorized for a daemon that refuses the gateway token', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'pc-token'), `${'x'.repeat(32)}\n`);

  ctx.pc.daemon.refreshTokens();

  const refused = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_dirs_list',
    arguments: { daemon: 'pc' },
  });

  expect(refused).toStrictEqual({
    content: [
      { type: 'text', text: "daemon_unauthorized: daemon 'pc' refused the gateway's token" },
    ],
    isError: true,
  });
});

test('it lists each daemon with its state, build, pinned id, and features but no address or token', async () => {
  await using ctx = await setupTest();

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_daemons_list',
    arguments: {},
  });

  expect(getRecord(listed, 'structuredContent')).toStrictEqual({
    daemons: [
      {
        name: 'cloud',
        state: 'up',
        build: ctx.cloud.build,
        daemonID: ctx.cloudID,
        features: expect.toIncludeAllMembers(['transport.tcp', 'spawn.idempotency']),
      },
      {
        name: 'pc',
        state: 'up',
        build: ctx.pc.build,
        daemonID: ctx.pcID,
        features: expect.toIncludeAllMembers(['transport.tcp', 'spawn.idempotency']),
      },
    ],
    defaultDaemon: 'cloud',
  });
});

test('it acts on each daemon as the verified client a daemon lists', async () => {
  await using ctx = await setupTest();

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_dirs_list',
    arguments: {},
  });

  expect(listed).not.toContainKey('isError');
  expect(listed).toContainKey('structuredContent');
});

test('it refuses a client no daemon lists as unauthorized', async () => {
  await using ctx = await setupTest();

  const refused = await sendMCPRequest(ctx.url, ctx.strangerToken, 'tools/call', {
    name: 'atc_dirs_list',
    arguments: {},
  });

  expect(refused).toStrictEqual({
    content: [{ type: 'text', text: expect.toStartWith('unauthorized: ') }],
    isError: true,
  });
});

test('it offers the daemon input on spawn and dirs and the daemons tool in the tool list', async () => {
  await using ctx = await setupTest();

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/list');

  const tools = [listed['tools']].flat().filter((tool) => isRecord(tool));
  const spawnTool = tools.find((tool) => tool['name'] === 'atc_session_spawn');
  const dirsTool = tools.find((tool) => tool['name'] === 'atc_dirs_list');
  const spawnSchema = getRecord(getRecord({ spawnTool }, 'spawnTool'), 'inputSchema');
  const dirsSchema = getRecord(getRecord({ dirsTool }, 'dirsTool'), 'inputSchema');

  expect(getRecord(spawnSchema, 'properties')).toContainKey('daemon');
  expect(getRecord(dirsSchema, 'properties')).toContainKey('daemon');
  expect(tools).toPartiallyContain({ name: 'atc_daemons_list' });
});

test('it lists the agents tool without an output schema', async () => {
  await using ctx = await setupTest();

  const listed = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/list');

  const agentsTool = [listed['tools']]
    .flat()
    .find((tool) => isRecord(tool) && tool['name'] === 'atc_agents_list');

  expect(getRecord({ agentsTool }, 'agentsTool')).not.toContainKey('outputSchema');
});

test('it answers the health probe with an empty body while every daemon is down', async () => {
  await using ctx = await setupTest();

  await ctx.cloud.stop();
  await ctx.pc.stop();

  const healthz = await fetch(`${ctx.url}/healthz`);

  expect([healthz.status, await healthz.text()]).toStrictEqual([200, '']);
});

test('it answers the readiness probe with an empty body while every daemon is down', async () => {
  await using ctx = await setupTest();

  await ctx.cloud.stop();
  await ctx.pc.stop();

  const readyz = await fetch(`${ctx.url}/readyz`);

  expect([readyz.status, await readyz.text()]).toStrictEqual([200, '']);
});

test('it refuses a probe for a foreign host', async () => {
  await using ctx = await setupTest();

  const foreign = await fetch(`${ctx.url}/readyz`, { headers: { host: 'evil.example' } });

  expect(foreign.status).toBe(403);
});

test('it holds a waiting events read open until one daemon has an event and returns it', async () => {
  await using ctx = await setupTest();

  const spawned = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir, daemon: 'pc' },
  });

  const session = String(getRecord(spawned, 'structuredContent')['id']);

  const caughtUp = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: {},
  });

  const waiting = sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: getRecord(caughtUp, 'structuredContent')['cursor'], waitMs: 10_000 },
  });

  // Each daemon holds a waiting read, timed at its wait on top of the
  // response time, before the message that ends the wait goes out.
  await waitFor(() => {
    expect(ctx.timers.collectPendingDelays()).toStrictEqual([40_000, 40_000]);
  });

  await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_message',
    arguments: { session, text: 'wake' },
  });

  const woken = await waiting;

  expect(getRecord(woken, 'structuredContent')['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-accepted', session }),
  ]);
});

test('it reads a report from either daemon through the report handle of its event', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'from cloud' },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'from pc' },
  });

  const reports = await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: {},
    });

    const found = [getRecord(read, 'structuredContent')['events']]
      .flat()
      .filter((event) => isRecord(event) && event['kind'] === 'report');

    expect(found).toHaveLength(2);

    return found;
  });

  const got = await Promise.all(
    reports.map((event) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_report_get',
        arguments: { report: getRecord({ event }, 'event')['report'] },
      }),
    ),
  );

  expect(got.map((answer) => getRecord(answer, 'structuredContent')['text'])).toIncludeSameMembers([
    'from cloud',
    'from pc',
  ]);
});

test('it refuses a report handle with a stale incarnation', async () => {
  await using ctx = await setupTest();

  const spawned = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_session_spawn',
    arguments: { cwd: ctx.dir },
  });

  await ctx.cloud.sendHookLines({
    atcId: String(getRecord(spawned, 'structuredContent')['id']).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'from cloud' },
  });

  const report = await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: {},
    });

    const found = [getRecord(read, 'structuredContent')['events']]
      .flat()
      .find((event) => isRecord(event) && event['kind'] === 'report');

    return String(getRecord({ found }, 'found')['report']);
  });

  const stale = report.replace(`cloud.${ctx.cloudID.slice(0, 8)}.`, 'cloud.ffffffff.');

  const refused = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_report_get',
    arguments: { report: stale },
  });

  expect(refused).toStrictEqual({
    content: [{ type: 'text', text: `bad_args: no report '${stale}'` }],
    isError: true,
  });
});

test('it reads the whole reports of both daemons in one events read', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'from cloud' },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'p'.repeat(1000) },
  });

  const page = await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: { reportText: true },
    });

    const structured = getRecord(read, 'structuredContent');

    expect([structured['events']].flat()).toIncludeAllPartialMembers([
      { kind: 'report', session: cloudID },
      { kind: 'report', session: pcID },
    ]);

    return structured;
  });

  expect(page).toMatchObject({ more: false, unavailable: [], truncated: [] });

  expect([page['events']].flat()).toIncludeAllPartialMembers([
    {
      kind: 'report',
      session: cloudID,
      label: 'cloud',
      detail: 'from cloud',
      text: 'from cloud',
      complete: true,
    },
    {
      kind: 'report',
      session: pcID,
      label: 'pc',
      detail: `${'p'.repeat(599)}…`,
      text: 'p'.repeat(1000),
      complete: true,
    },
  ]);
});

test('it resumes a report text read after the reports of its page', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'from cloud' },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'from pc' },
  });

  const first = await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: { reportText: true },
    });

    const structured = getRecord(read, 'structuredContent');

    expect([structured['events']].flat()).toIncludeAllPartialMembers([
      { kind: 'report', session: cloudID },
      { kind: 'report', session: pcID },
    ]);

    return structured;
  });

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'later' },
  });

  const next = await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: { cursor: first['cursor'], reportText: true },
    });

    const structured = getRecord(read, 'structuredContent');

    expect(structured['events']).toBeArray();
    expect(structured['events']).not.toBeEmpty();

    return structured;
  });

  expect(next['events']).toStrictEqual([
    expect.objectContaining({ kind: 'report', session: cloudID, text: 'later', complete: true }),
  ]);
});

test('it reads the whole reports of the daemons that answer and lists the one that does not', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'from cloud' },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'from pc' },
  });

  await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: {},
    });

    expect([getRecord(read, 'structuredContent')['events']].flat()).toIncludeAllPartialMembers([
      { kind: 'report', session: cloudID },
      { kind: 'report', session: pcID },
    ]);
  });

  await ctx.pc.stop();

  const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { reportText: true },
  });

  const page = getRecord(read, 'structuredContent');

  expect(page).toMatchObject({ unavailable: ['pc'], more: false });

  expect(page['events']).toStrictEqual([
    expect.objectContaining({
      kind: 'report',
      session: cloudID,
      text: 'from cloud',
      complete: true,
    }),
  ]);
});

test('it stops a report text read across daemons at 64 KiB', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'c'.repeat(40_000) },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'p'.repeat(30_000) },
  });

  await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: {},
    });

    expect([getRecord(read, 'structuredContent')['events']].flat()).toIncludeAllPartialMembers([
      { kind: 'report', session: cloudID },
      { kind: 'report', session: pcID },
    ]);
  });

  const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { reportText: true },
  });

  const page = getRecord(read, 'structuredContent');

  expect(page['more']).toBeTrue();

  expect(
    [page['events']].flat().filter((event) => isRecord(event) && event['kind'] === 'report'),
  ).toStrictEqual([
    expect.objectContaining({ session: cloudID, text: 'c'.repeat(40_000), complete: true }),
  ]);
});

test('it reads the rest of a report text read stopped at 64 KiB at its cursor', async () => {
  await using ctx = await setupTest();

  const spawns = await Promise.all(
    ['cloud', 'pc'].map((daemon) =>
      sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
        name: 'atc_session_spawn',
        arguments: { cwd: ctx.dir, daemon },
      }),
    ),
  );

  const [cloudID, pcID] = spawns.map((spawned) =>
    String(getRecord(spawned, 'structuredContent')['id']),
  );

  await ctx.cloud.sendHookLines({
    atcId: String(cloudID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'cloud', text: 'c'.repeat(40_000) },
  });

  await ctx.pc.sendHookLines({
    atcId: String(pcID).split('.').at(-1),
    event: 'Report',
    payload: { kind: 'note', label: 'pc', text: 'p'.repeat(30_000) },
  });

  await waitFor(async () => {
    const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
      name: 'atc_events_read',
      arguments: {},
    });

    expect([getRecord(read, 'structuredContent')['events']].flat()).toIncludeAllPartialMembers([
      { kind: 'report', session: cloudID },
      { kind: 'report', session: pcID },
    ]);
  });

  const first = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { reportText: true },
  });

  const read = await sendMCPRequest(ctx.url, ctx.claudeToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: getRecord(first, 'structuredContent')['cursor'], reportText: true },
  });

  const page = getRecord(read, 'structuredContent');

  expect(page['more']).toBeFalse();

  expect(
    [page['events']].flat().filter((event) => isRecord(event) && event['kind'] === 'report'),
  ).toStrictEqual([
    expect.objectContaining({ session: pcID, text: 'p'.repeat(30_000), complete: true }),
  ]);
});
