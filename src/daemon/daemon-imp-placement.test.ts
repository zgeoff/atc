import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A daemon with three targets: `local` on the daemon's machine, the
 * default, and two imp targets, `box` and `other`, over one stub imp
 * port, so every imp either one makes lists in the same place. Every
 * session runs an agent that stays up reading its input, on any target.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const port = stack.use(buildStubImpPort());

  const daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'fake-claude'), '#!/usr/bin/env bash\necho UP\nexec cat\n', {
        mode: 0o755,
      });

      return {
        adapter: buildMockAgentAdapter({
          planSpawn: () => ({ bin: join(paths.dir, 'fake-claude'), args: [] }),
        }),
        targets: [
          {
            id: 'local',
            kind: 'local-pty',
            options: {},
            identity: 'local-pty:test',
            provider: new LocalPTYProvider(),
          },
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(port, { guestDir: join(paths.dir, id) }),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  stack.use(daemon);

  const moved = stack.move();

  return { port, daemon, [Symbol.asyncDispose]: () => moved.disposeAsync() };
}

test("it runs a sub-session on its parent's target as another session in its parent's imp", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  const imps = ctx.port.collectImpNames();
  const names = ctx.port.sessionRequests.map((request) => request.name);

  // Each distinct session the imp was asked to start, once.
  const sessions = [...new Set(ctx.port.sessionRequests.map((request) => request.session))];

  expect<Record<string, unknown>>({ imps, names, sessions }).toStrictEqual({
    imps: [expect.any(String)],
    names: [imps[0], imps[0]],
    sessions: [expect.any(String), expect.any(String)],
  });
});

test("it puts a parent's imp to sleep once its only session is killed", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const [imp] = ctx.port.collectImpNames();

  await ctx.daemon.client.sendRequest('session.kill', {
    session: getRecord(parent, 'session')['id'],
  });

  expect(ctx.port.findState(String(imp))).toBe('sleeping');
});

test("it wakes a sleeping parent's imp to start a sub-session there", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await ctx.daemon.client.sendRequest('session.kill', { session: parentID });

  await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: parentID,
  });

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    state: ctx.port.findState(String(imp)),
  }).toStrictEqual({ imps: [imp], state: 'running' });
});

test('it gives a sub-session without a target a host of its own on the default target', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  expect({
    locator: getRecord(getRecord(child, 'session'), 'locator'),
    imps: ctx.port.collectImpNames(),
    requests: ctx.port.sessionRequests,
  }).toMatchObject({
    locator: { targetID: 'local' },
    imps: [expect.any(String)],
    requests: [expect.anything()],
  });
});

test('it gives a sub-session on another imp target an imp of its own', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
    target: 'other',
    parent: getRecord(parent, 'session')['id'],
  });

  expect(ctx.port.collectImpNames()).toHaveLength(2);
});
