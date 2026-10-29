import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { createImpProvider } from '@atc/execution-imp';
import { buildReporterSocketBase, createStubImpPort } from '@atc/execution-imp/testing';
import { createClaudeAdapter } from '@atc/harness-claude';
import { startInProcessMCP } from '@atc/mcp/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockHostServices,
  createStubGuestCLIs,
  getAgentEntry,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { createHostServices } from '../packages/app/src/create-host-services';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A real daemon whose default target `box` runs on the imp provider over the
// stub imp port, beside the local target; each session's MCP server reaches
// the daemon through that session's own bridge socket, as one in the guest does.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-access-');
  const clis = createStubGuestCLIs(join(temporaryDirectory.path, 'bin'));
  const guestDir = join(temporaryDirectory.path, 'g');
  const port = createStubImpPort();
  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: clis.claude } } });

  const daemon = await startTestDaemon({
    prefix: 'atc-access-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: createImpProvider(
            port,
            { guestDir, guestATC: clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
        buildLocalTarget(),
      ],
      defaultTarget: 'box',
    }),
  });

  const buildBridgeSocket = (session: string) =>
    `${buildReporterSocketBase(guestDir, session)}.sock`;

  const openSessionMCP = (session: string) =>
    startInProcessMCP({
      socketPath: buildBridgeSocket(session),
      build: daemon.build,
      callerSessionID: session,
    });

  return { daemon, port, guestDir, buildBridgeSocket, openSessionMCP };
}

test('it lets a session spawned with atc access spawn a sub-session, message it and read its notes', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'message', 'spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);
  const worker = await mcp.spawnSession({ cwd: ctx.daemon.directory, name: 'worker' });

  await ctx.daemon.client.sendRequest('session.input', {
    session: worker,
    data: `tap ${join(ctx.daemon.directory, 'tap.log')}\r`,
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: worker,
    data: 'note half the files are done\r',
  });

  await waitFor(async () => {
    const sent = await mcp.sendToolCall('atc_message_send', {
      session: worker,
      text: 'carry on',
    });

    expect(sent.isError).toBeUndefined();
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({ id: worker, parent: holder });

  await waitFor(async () => {
    const events = await mcp.sendToolCall('atc_events_read', { session: worker });

    expect(events.structured?.['events']).toPartiallyContain({
      kind: 'note',
      text: 'half the files are done',
    });
  });
});

test('it gives a session spawned with atc access an atc MCP server in its guest config', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read'],
  });

  const directory = join(ctx.guestDir, 'sessions', String(getRecord(spawned, 'session')['id']));
  const mcpConfig: unknown = JSON.parse(readFileSync(join(directory, 'mcp.json'), 'utf8'));

  expect(mcpConfig).toStrictEqual({
    mcpServers: {
      atc: { type: 'stdio', command: join(ctx.guestDir, 'bin', 'atc'), args: ['mcp'] },
    },
  });

  const mcpConfigPath = join(directory, 'mcp.json');

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({ argv: expect.arrayContaining(['--mcp-config', mcpConfigPath]) }),
  ]);
});

test('it gives a session spawned without atc access no atc MCP server and closes a client connection on its bridge', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
  });

  const session = String(getRecord(spawned, 'session')['id']);
  const directory = join(ctx.guestDir, 'sessions', session);

  const client = await openDaemonClient(ctx.buildBridgeSocket(session));

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello(ctx.daemon.build, { session })).rejects.toThrow();
  expect(existsSync(join(directory, 'mcp.json'))).toBe(false);

  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start');

  expect(ctx.port.sessionRequests).toHaveLength(1);
  expect(request.argv).not.toContain('--mcp-config');
});

test('it refuses a session with atc access a session outside its subtree and its parent', async () => {
  const ctx = await setupTest();

  const other = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'bystander',
    cols: 80,
    rows: 24,
  });

  const bystander = String(getRecord(other, 'session')['id']);

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'message', 'spawn', 'kill'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);
  const read = await mcp.sendToolCall('atc_session_get', { session: bystander });
  const sent = await mcp.sendToolCall('atc_message_send', { session: bystander, text: 'hello' });
  const stopped = await mcp.sendToolCall('atc_session_stop', { session: bystander });
  const listed = await mcp.sendToolCall('atc_sessions_list', {});

  expect(read.text).toStartWith('no_such_session');
  expect(sent.text).toStartWith('no_such_session');
  expect(stopped.text).toStartWith('no_such_session');
  expect(listed.structured?.['sessions']).toStrictEqual([expect.objectContaining({ id: holder })]);
});

test('it lets a session with atc access message its parent and nothing more', async () => {
  const ctx = await setupTest();

  const parentSpawn = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'coordinator',
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'message'],
  });

  const parent = String(getRecord(parentSpawn, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: parent,
    data: `tap ${join(ctx.daemon.directory, 'tap.log')}\r`,
  });

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    parent,
    atcAccess: ['read', 'message'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);

  await waitFor(async () => {
    const sent = await mcp.sendToolCall('atc_message_send', { session: parent, text: 'done' });

    expect(sent.isError).toBeUndefined();
  });

  const read = await mcp.sendToolCall('atc_session_get', { session: parent });
  const renamed = await mcp.sendToolCall('atc_session_update', { session: parent, name: 'x' });

  expect(read.text).toStartWith('no_such_session');
  expect(renamed.text).toStartWith('no_such_session');
});

test('it lets a sub-session with atc access reach the sessions it spawns beside it but not its siblings', async () => {
  const ctx = await setupTest();

  const parentSpawn = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'coordinator',
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'spawn'],
  });

  const parent = String(getRecord(parentSpawn, 'session')['id']);

  const siblingSpawn = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'sibling',
    cols: 80,
    rows: 24,
    parent,
  });

  const sibling = String(getRecord(siblingSpawn, 'session')['id']);

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    parent,
    atcAccess: ['read', 'spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);
  const worker = await mcp.spawnSession({ cwd: ctx.daemon.directory, name: 'worker' });
  const listed = await mcp.sendToolCall('atc_sessions_list', {});

  expect(listed.structured?.['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: holder, parent }),
    expect.objectContaining({ id: worker, parent }),
  ]);

  expect(listed.structured?.['sessions']).not.toPartiallyContain({ id: sibling });
});

test("it keeps a session's atc access across a daemon restart", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: holder,
    data: 'start conversation-restored\r',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.get', { session: holder });

    expect(read).toMatchObject({ session: { agentSessionID: 'conversation-restored' } });
  });

  await ctx.daemon.restart();
  await ctx.daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const mcp = await ctx.openSessionMCP(holder);

  await waitFor(async () => {
    const listed = await mcp.sendToolCall('atc_sessions_list', {});

    expect(listed.structured?.['sessions']).toStrictEqual([
      expect.objectContaining({ id: holder }),
    ]);
  });
});

test('it lets a session with kill stop its sub-session but never itself', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['spawn', 'kill'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);
  const worker = await mcp.spawnSession({ cwd: ctx.daemon.directory, name: 'worker' });
  const own = await mcp.sendToolCall('atc_session_stop', { session: holder });
  const sub = await mcp.sendToolCall('atc_session_stop', { session: worker });

  expect(own.text).toStartWith('no_such_session');
  expect(sub.isError).toBeUndefined();
});

test('it refuses a spawn from a session with atc access that resumes an agent session out of its reach', async () => {
  const ctx = await setupTest();

  const other = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
  });

  const otherID = String(getRecord(other, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: otherID,
    data: 'start conversation-elsewhere\r',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.get', { session: otherID });

    expect(read).toMatchObject({ session: { agentSessionID: 'conversation-elsewhere' } });
  });

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const client = await openDaemonClient(ctx.buildBridgeSocket(holder));

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello(ctx.daemon.build, {});

  expect(
    client.sendRequest('session.spawn', {
      cwd: ctx.daemon.directory,
      cols: 80,
      rows: 24,
      resume: 'conversation-elsewhere',
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it refuses a spawn from a session with atc access that resumes the latest agent session', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const client = await openDaemonClient(ctx.buildBridgeSocket(holder));

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello(ctx.daemon.build, {});

  expect(
    client.sendRequest('session.spawn', {
      cwd: ctx.daemon.directory,
      cols: 80,
      rows: 24,
      resume: true,
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it lets a session with atc access spawn a session that resumes an agent session in its reach', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: holder,
    data: 'start conversation-own\r',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.get', { session: holder });

    expect(read).toMatchObject({ session: { agentSessionID: 'conversation-own' } });
  });

  const client = await openDaemonClient(ctx.buildBridgeSocket(holder));

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello(ctx.daemon.build, {});

  const resumed = await client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    resume: 'conversation-own',
  });

  expect(getRecord(resumed, 'session')['agentSessionID']).toBe('conversation-own');
});

test('it refuses a spawn from a session with atc access that grants a scope the session lacks', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);

  const widened = await mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.daemon.directory,
    atcAccess: ['read', 'message'],
  });

  expect(widened.text).toStartWith('unauthorized');
  expect(widened.text).toInclude('cannot grant message');
});

test('it lets a session with atc access grant a sub-session the scopes it holds', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['read', 'spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);

  const narrowed = await mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.daemon.directory,
    atcAccess: ['read'],
  });

  expect(narrowed.isError).toBeUndefined();
});

test('it refuses a spawn from a session with atc access on another target than its own', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
    atcAccess: ['spawn'],
  });

  const holder = String(getRecord(spawned, 'session')['id']);

  const mcp = await ctx.openSessionMCP(holder);

  const local = await mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.daemon.directory,
    target: 'local',
  });

  expect(local.text).toStartWith('target_forbidden');
});

test('it refuses atc access on a target that runs the agent on the daemon machine', async () => {
  const ctx = await setupTest();

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.daemon.directory,
      cols: 80,
      rows: 24,
      target: 'local',
      atcAccess: ['read'],
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it refuses atc access to a sub-session that shares a host whose session lacks the scope', async () => {
  const ctx = await setupTest();

  const parentSpawn = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
  });

  const parent = String(getRecord(parentSpawn, 'session')['id']);

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.daemon.directory,
      cols: 80,
      rows: 24,
      parent,
      atcAccess: ['read'],
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it keeps the agent session id of a remote session that reports one a session on another host holds', async () => {
  const ctx = await setupTest();

  const first = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
  });

  const second = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    cols: 80,
    rows: 24,
  });

  const owner = String(getRecord(first, 'session')['id']);
  const claimer = String(getRecord(second, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: owner,
    data: 'start conversation-kept\r',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.get', { session: owner });

    expect(read).toMatchObject({ session: { agentSessionID: 'conversation-kept' } });
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: claimer,
    data: 'start conversation-kept\r',
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: claimer,
    data: 'notify claim reported\r',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.get', { session: claimer });

    expect(read).toMatchObject({ session: { lastMsg: 'claim reported' } });
  });

  const read = await ctx.daemon.client.sendRequest('session.get', { session: claimer });

  expect(getRecord(read, 'session')['agentSessionID']).toBeUndefined();
});
