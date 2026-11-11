import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildMockAgentAdapter, createStubEchoClaude, getRecord, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A daemon with a local target and an imp target `box` over a stub imp port.
async function setupTest() {
  const port = createStubImpPort();

  const daemon = await startTestDaemon({
    options: (paths) => {
      const fakeClaude = createStubEchoClaude(paths.directory);

      return {
        adapter: buildMockAgentAdapter({ planSpawn: () => ({ bin: fakeClaude, args: [] }) }),
        targets: [
          {
            id: 'local',
            kind: 'local-pty',
            options: {},
            identity: 'local-pty:test',
            provider: createLocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: createImpProvider(
              port,
              { guestDir: join(paths.directory, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
        ],
        defaultTarget: 'local',
      };
    },
  });

  const readHost = async (session: unknown) => {
    const got = await daemon.client.sendRequest('session.get', { session });

    return getRecord(got, 'session')['host'];
  };

  const readImpID = async (name: string) => {
    const imp = await port.readImp(name);

    invariant(imp !== null, `impd holds no imp ${name}`);

    return imp.id;
  };

  return { ...daemon, port, readHost, readImpID };
}

test('it reads the name, id and issuer of the imp a session runs on', async () => {
  const ctx = await setupTest();

  ctx.port.issuer = 'https://impd.example.test';

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const [name] = ctx.port.collectImpNames();

  invariant(name !== undefined, 'the spawn created no imp');

  const impID = await ctx.readImpID(name);
  const host = await ctx.readHost(getRecord(spawned, 'session')['id']);

  expect(host).toStrictEqual({ name, id: impID, issuer: 'https://impd.example.test' });
});

test('it reads no host key for a local session', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'local',
  });

  const host = await ctx.readHost(getRecord(spawned, 'session')['id']);

  expect(getRecord(spawned, 'session')).not.toContainKey('host');
  expect(host).toBeUndefined();
});

test('it reads a host with a name and an id but no issuer while impd has identity off', async () => {
  const ctx = await setupTest();

  ctx.port.issuer = null;

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const [name] = ctx.port.collectImpNames();

  invariant(name !== undefined, 'the spawn created no imp');

  const impID = await ctx.readImpID(name);
  const host = await ctx.readHost(getRecord(spawned, 'session')['id']);

  expect(host).toStrictEqual({ name, id: impID });
});

test('it reads the new imp id after the imp is destroyed and made again under the same name', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];
  const [name] = ctx.port.collectImpNames();

  invariant(name !== undefined, 'the spawn created no imp');

  const oldImpID = await ctx.readImpID(name);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.port.destroyImp(name);
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const newImpID = await ctx.readImpID(name);

  expect(newImpID).not.toBe(oldImpID);

  const host = await ctx.readHost(id);

  expect(host).toStrictEqual({ name, id: newImpID, issuer: expect.any(String) });
});

test("it reads a sub-session's host as its parent's host", async () => {
  const ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  const parentHost = await ctx.readHost(getRecord(parent, 'session')['id']);

  expect(parentHost).toStrictEqual({
    name: expect.any(String),
    id: expect.any(String),
    issuer: expect.any(String),
  });

  expect(getRecord(child, 'session')['host']).toStrictEqual(parentHost);
});

test("it reads a live session's imp id after a daemon restart and restore", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    target: 'box',
    resume: 'agent-session-1',
  });

  const id = getRecord(spawned, 'session')['id'];
  const [name] = ctx.port.collectImpNames();

  invariant(name !== undefined, 'the spawn created no imp');

  await ctx.restart();

  const client = await ctx.openClient();

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: true });
  });

  const got = await client.sendRequest('session.get', { session: id });
  const impID = await ctx.readImpID(name);

  expect(getRecord(got, 'session')['host']).toStrictEqual({
    name,
    id: impID,
    issuer: expect.any(String),
  });
});
