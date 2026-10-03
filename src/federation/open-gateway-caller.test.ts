import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJSONRecord } from '../../test/read-json-record';
import { runMCPAuthorization } from '../../test/run-mcp-authorization';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import type { DaemonHandle } from '../daemon/daemon';
import { openMCPAuth } from '../mcp/open-mcp-auth';
import { startMCPHTTPServer } from '../mcp/start-mcp-http-server';
import type { DaemonFeature } from '../protocol/daemon-features';
import { getRecord } from '../shared/get-record';
import { isRecord, sendReport } from '../shared/report';
import { openGatewayCaller } from './open-gateway-caller';
import { parseGatewayRegistry } from './parse-gateway-registry';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const TOKENS: Readonly<Record<string, string>> = {
  cloud: 'c'.repeat(32),
  pc: 'p'.repeat(32),
};

interface GatewaySetupOptions {
  // The token the gateway presents to `pc`, when it is not pc's own.
  readonly pcToken?: string;

  // Puts an older daemon announcing only these features behind `pc`.
  readonly legacyPC?: readonly DaemonFeature[];
}

/**
 * The gateway's caller behind the MCP HTTP server, as the gateway entrypoint
 * wires them, in front of two real daemons, `cloud` (the default) and
 * `pc`, each listening on a loopback TCP port with its own bearer token
 * and a principals key that lets the OAuth client `Claude` use the local
 * target; `Stranger` is a second client no daemon lists. `connect` runs
 * the OAuth code flow with PKCE for a client and returns an MCP client
 * holding its access token: `callTool` returns a tool call's result, and
 * `sendRPC` any JSON-RPC request's. `owner` is a daemon owner's own
 * connection on its local socket, `reporterPath` the socket its sessions'
 * reporters send to, and `stopDaemon` stops a daemon.
 */
async function setupTest(options: GatewaySetupOptions = {}) {
  const tmp = setupTempDir('atc-gateway-');
  const authDBPath = join(tmp.dir, 'mcp-auth.db');

  const auth = await openMCPAuth({ dbPath: authDBPath, origin: null });

  const createClient = async (name: string) => {
    const created = await auth.auth.api.createFixedClient({
      body: { name, redirectURIs: [REDIRECT_URI] },
    });

    return created.clientID;
  };

  const clientIDs = {
    Claude: await createClient('Claude'),
    Stranger: await createClient('Stranger'),
  };

  const handles = new Map<string, DaemonHandle>();
  const owners = new Map<string, DaemonClient>();
  const ports = new Map<string, number>();
  const daemonIDs = new Map<string, string>();

  for (const name of ['cloud', 'pc']) {
    const dir = join(tmp.dir, name);

    mkdirSync(dir);
    writeFileSync(join(dir, 'token'), `${TOKENS[name]}\n`);

    const handle = await startDaemon({
      socketPath: join(dir, 'daemon.sock'),
      reporterSocketPath: join(dir, 'reporter.sock'),
      build: `atc/test-${name}`,
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(dir, 'state.db'),
      statusPath: join(dir, 'status.json'),
      principals: new Map([[clientIDs.Claude, ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(dir, 'token') },
    });

    const owner = await DaemonClient.open(join(dir, 'daemon.sock'));
    const hello = await owner.sendHello('atc/test-build');

    handles.set(name, handle);
    owners.set(name, owner);
    ports.set(name, handle.listenPort ?? 0);
    daemonIDs.set(name, String(hello['daemonID']));
  }

  const legacySocket = join(tmp.dir, 'legacy.sock');

  const legacy =
    options.legacyPC === undefined
      ? null
      : startLegacyDaemon(legacySocket, {
          replies: {
            'daemon.hello': {
              daemon: 'atc/legacy-build',
              daemonID: daemonIDs.get('pc'),
              features: options.legacyPC,
            },
          },
        });

  const parsed = parseGatewayRegistry(
    {
      daemons: Object.fromEntries(
        ['cloud', 'pc'].map((name) => [
          name,
          { address: `127.0.0.1:${ports.get(name)}`, daemonID: daemonIDs.get(name) },
        ]),
      ),
      defaultDaemon: 'cloud',
    },
    {
      ATC_GATEWAY_TOKEN_CLOUD: TOKENS['cloud'],
      ATC_GATEWAY_TOKEN_PC: options.pcToken ?? TOKENS['pc'],
    },
  );

  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }

  const approvals: string[] = [];
  const pcPort = ports.get('pc');

  const gateway = openGatewayCaller({
    registry: parsed.registry,
    build: 'atc-gateway/test',
    openChannel: (address) =>
      legacy !== null && address.port === pcPort
        ? DaemonClient.open(legacySocket)
        : DaemonClient.open({ hostname: address.host, port: address.port }),
    gatewayDBPath: join(tmp.dir, 'gateway.db'),
    fanOutTimeoutMs: 1000,
  });

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

  const sendRPC = async (
    token: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const answered = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

    const body = await readJSONRecord(answered);

    return getRecord(body, 'result');
  };

  return {
    url: server.url,
    daemonIDs,
    approvals,
    legacyRequests: legacy?.requests ?? [],
    owner(name: string): DaemonClient {
      const owner = owners.get(name);

      if (owner === undefined) {
        throw new Error(`no daemon '${name}'`);
      }

      return owner;
    },
    reporterPath: (name: string) => join(tmp.dir, name, 'reporter.sock'),
    async stopDaemon(name: string): Promise<void> {
      await handles.get(name)?.stop();

      handles.delete(name);
    },
    async connect(client: 'Claude' | 'Stranger') {
      const clientID = clientIDs[client];

      const authorized = await runMCPAuthorization(
        { url: server.url, origin: server.origin, approvals },
        {
          clientID,
          redirectURI: REDIRECT_URI,
          scope: 'read message spawn kill',
          ticked: ['read', 'message', 'spawn', 'kill'],
        },
      );

      const exchanged = await fetch(`${server.url}/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authorized.code,
          redirect_uri: REDIRECT_URI,
          client_id: clientID,
          code_verifier: authorized.verifier,
          resource: `${server.origin}/mcp`,
        }),
      });

      const tokens = await readJSONRecord(exchanged);

      const token = String(tokens['access_token']);

      return {
        sendRPC: (method: string, params: Readonly<Record<string, unknown>> = {}) =>
          sendRPC(token, method, params),
        callTool: (name: string, args: Readonly<Record<string, unknown>> = {}) =>
          sendRPC(token, 'tools/call', { name, arguments: args }),
      };
    },
    async [Symbol.asyncDispose]() {
      await server.stop();
      await gateway.stop();
      await auth.close();

      for (const owner of owners.values()) {
        owner.stop();
      }

      for (const handle of handles.values()) {
        await handle.stop();
      }

      legacy?.stop();
      tmp[Symbol.dispose]();
    },
  };
}

test('it lists the sessions of both daemons under gateway ids with each daemon up', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  await client.callTool('atc_session_spawn', { cwd: '/tmp', name: 'on-cloud' });
  await client.callTool('atc_session_spawn', { cwd: '/tmp', name: 'on-pc', daemon: 'pc' });

  const listed = await client.callTool('atc_session_list');

  const structured = getRecord(listed, 'structuredContent');
  const cloudPrefix = `cloud.${gateway.daemonIDs.get('cloud')?.slice(0, 8)}.`;
  const pcPrefix = `pc.${gateway.daemonIDs.get('pc')?.slice(0, 8)}.`;

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
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  const spawned = await client.callTool('atc_session_spawn', {
    cwd: '/tmp',
    name: 'on-pc',
    daemon: 'pc',
  });

  const id = String(getRecord(spawned, 'structuredContent')['id']);

  const got = await client.callTool('atc_session_get', { session: id });
  const ownList = await gateway.owner('pc').sendRequest('session.list');

  expect(getRecord(getRecord(got, 'structuredContent'), 'session')).toMatchObject({
    id,
    name: 'on-pc',
  });

  expect(ownList['sessions']).toStrictEqual([
    expect.objectContaining({ id: id.split('.').at(-1), name: 'on-pc' }),
  ]);
});

test('it replays a keyed spawn from the daemon the key was bound to when the retry leaves the daemon out', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  const first = await client.callTool('atc_session_spawn', {
    cwd: '/tmp',
    name: 'keyed',
    daemon: 'pc',
    idempotencyKey: 'spawn-once',
  });

  const retried = await client.callTool('atc_session_spawn', {
    cwd: '/tmp',
    name: 'keyed',
    idempotencyKey: 'spawn-once',
  });

  const cloudList = await gateway.owner('cloud').sendRequest('session.list');
  const pcList = await gateway.owner('pc').sendRequest('session.list');

  expect(getRecord(retried, 'structuredContent')['id']).toBe(
    getRecord(first, 'structuredContent')['id'],
  );

  expect(cloudList['sessions']).toStrictEqual([]);
  expect(pcList['sessions']).toHaveLength(1);
});

test('it reads the events of both daemons in one page and resumes after them', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  const ids: string[] = [];

  for (const daemon of ['cloud', 'pc']) {
    const spawned = await client.callTool('atc_session_spawn', { cwd: '/tmp', daemon });

    ids.push(String(getRecord(spawned, 'structuredContent')['id']));
  }

  for (const [index, session] of ids.entries()) {
    await client.callTool('atc_session_message', { session, text: `hello ${index}` });
  }

  const firstRead = await client.callTool('atc_events_read');

  const first = getRecord(firstRead, 'structuredContent');

  await client.callTool('atc_session_message', { session: ids[1], text: 'later' });

  const nextRead = await client.callTool('atc_events_read', { cursor: first['cursor'] });

  const next = getRecord(nextRead, 'structuredContent');

  const firstSessions = [first['events']]
    .flat()
    .filter((event) => isRecord(event) && event['kind'] === 'message-accepted')
    .map((event) => (isRecord(event) ? event['session'] : null));

  expect(firstSessions).toIncludeAllMembers(ids);
  expect(first['unavailable']).toStrictEqual([]);

  expect(next['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-accepted', session: ids[1] }),
  ]);
});

test('it shows a stopped daemon as down and refuses a spawn there as daemon_unavailable', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  await gateway.stopDaemon('pc');

  const listRead = await client.callTool('atc_session_list');

  const listed = getRecord(listRead, 'structuredContent');

  const refused = await client.callTool('atc_session_spawn', { cwd: '/tmp', daemon: 'pc' });

  expect(listed['daemons']).toStrictEqual([
    { name: 'cloud', state: 'up' },
    { name: 'pc', state: 'down' },
  ]);

  expect(refused).toStrictEqual({
    content: [{ type: 'text', text: "daemon_unavailable: daemon 'pc' is unreachable" }],
    isError: true,
  });
});

test('it answers daemon_unauthorized for a daemon that refuses the gateway token', async () => {
  await using gateway = await setupTest({ pcToken: 'x'.repeat(32) });

  const client = await gateway.connect('Claude');
  const refused = await client.callTool('atc_dirs_list', { daemon: 'pc' });

  expect(refused).toStrictEqual({
    content: [
      { type: 'text', text: "daemon_unauthorized: daemon 'pc' refused the gateway's token" },
    ],
    isError: true,
  });
});

test('it answers daemon_outdated for a keyed spawn on a daemon without keyed spawns and sends it nothing', async () => {
  await using gateway = await setupTest({
    legacyPC: ['transport.tcp', 'request.principal', 'daemon.id'],
  });

  const client = await gateway.connect('Claude');

  const refused = await client.callTool('atc_session_spawn', {
    cwd: '/tmp',
    daemon: 'pc',
    idempotencyKey: 'spawn-old',
  });

  expect(refused).toStrictEqual({
    content: [{ type: 'text', text: expect.toStartWith("daemon_outdated: daemon 'pc' ") }],
    isError: true,
  });

  expect(gateway.legacyRequests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it lists each daemon with its state, build, pinned id, and features but no address or token', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');
  const daemonsRead = await client.callTool('atc_daemons_list');

  const listed = getRecord(daemonsRead, 'structuredContent');

  expect(listed).toStrictEqual({
    daemons: [
      {
        name: 'cloud',
        state: 'up',
        build: 'atc/test-cloud',
        daemonID: gateway.daemonIDs.get('cloud'),
        features: expect.toIncludeAllMembers(['transport.tcp', 'spawn.idempotency']),
      },
      {
        name: 'pc',
        state: 'up',
        build: 'atc/test-pc',
        daemonID: gateway.daemonIDs.get('pc'),
        features: expect.toIncludeAllMembers(['transport.tcp', 'spawn.idempotency']),
      },
    ],
    defaultDaemon: 'cloud',
  });
});

test('it acts on each daemon as the verified client, so a client no daemon lists is refused', async () => {
  await using gateway = await setupTest();

  const claude = await gateway.connect('Claude');
  const strangerClient = await gateway.connect('Stranger');
  const listed = await claude.callTool('atc_dirs_list');
  const stranger = await strangerClient.callTool('atc_dirs_list');

  expect(listed['isError']).toBeUndefined();

  expect(stranger).toStrictEqual({
    content: [{ type: 'text', text: expect.toStartWith('unauthorized: ') }],
    isError: true,
  });
});

test('it offers the daemon input on spawn and dirs and the daemons tool in the tool list', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');
  const listed = await client.sendRPC('tools/list');

  const tools = [listed['tools']].flat().filter((tool) => isRecord(tool));

  const byName = new Map(tools.map((tool) => [tool['name'], tool]));

  const spawnSchema = getRecord(byName.get('atc_session_spawn') ?? {}, 'inputSchema');
  const dirsSchema = getRecord(byName.get('atc_dirs_list') ?? {}, 'inputSchema');

  expect(getRecord(spawnSchema, 'properties')).toContainKey('daemon');
  expect(getRecord(dirsSchema, 'properties')).toContainKey('daemon');
  expect(byName.has('atc_daemons_list')).toBe(true);
  expect(byName.get('atc_agents_list')).not.toContainKey('outputSchema');
});

test('it answers the probes with empty bodies while every daemon is down and refuses a foreign host', async () => {
  await using gateway = await setupTest();

  await gateway.stopDaemon('cloud');
  await gateway.stopDaemon('pc');

  const healthz = await fetch(`${gateway.url}/healthz`);
  const readyz = await fetch(`${gateway.url}/readyz`);
  const foreign = await fetch(`${gateway.url}/readyz`, { headers: { host: 'evil.example' } });

  expect([healthz.status, await healthz.text()]).toStrictEqual([200, '']);
  expect([readyz.status, await readyz.text()]).toStrictEqual([200, '']);
  expect(foreign.status).toBe(403);
});

test('it holds a waiting events read open until one daemon has an event and returns it at once', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');
  const spawned = await client.callTool('atc_session_spawn', { cwd: '/tmp', daemon: 'pc' });

  const session = String(getRecord(spawned, 'structuredContent')['id']);

  const caughtUp = await client.callTool('atc_events_read');

  const cursor = getRecord(caughtUp, 'structuredContent')['cursor'];
  const started = Date.now();
  const waiting = client.callTool('atc_events_read', { cursor, waitMs: 10_000 });

  await Bun.sleep(300);
  await client.callTool('atc_session_message', { session, text: 'wake' });

  const woken = await waiting;

  expect(getRecord(woken, 'structuredContent')['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-accepted', session }),
  ]);

  expect(Date.now() - started).toBeWithin(300, 5000);
});

test('it reads a report from either daemon through the report handle of its event and refuses a stale incarnation', async () => {
  await using gateway = await setupTest();

  const client = await gateway.connect('Claude');

  for (const daemon of ['cloud', 'pc']) {
    const spawned = await client.callTool('atc_session_spawn', { cwd: '/tmp', daemon });

    const session = String(getRecord(spawned, 'structuredContent')['id']);

    await sendReport(
      gateway.reporterPath(daemon),
      `${JSON.stringify({ atcId: session.split('.').at(-1), event: 'Report', payload: { kind: 'note', label: daemon, text: `from ${daemon}` } })}\n`,
      2000,
    );
  }

  const reports = await waitFor(async () => {
    const read = await client.callTool('atc_events_read');

    const found = [getRecord(read, 'structuredContent')['events']]
      .flat()
      .filter((event) => isRecord(event) && event['kind'] === 'report');

    if (found.length < 2) {
      throw new Error('both reports have not arrived yet');
    }

    return found.filter((event) => isRecord(event));
  });

  const texts: unknown[] = [];

  for (const event of reports) {
    const got = await client.callTool('atc_report_get', { report: event['report'] });

    texts.push(getRecord(got, 'structuredContent')['text']);
  }

  const handle = String(reports[0]?.['report']);
  const [name, , local] = handle.split('.');

  const stale = await client.callTool('atc_report_get', { report: `${name}.ffffffff.${local}` });

  expect(texts).toIncludeSameMembers(['from cloud', 'from pc']);

  expect(stale).toStrictEqual({
    content: [{ type: 'text', text: `bad_args: no report '${name}.ffffffff.${local}'` }],
    isError: true,
  });
});
