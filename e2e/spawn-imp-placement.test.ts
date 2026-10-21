import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildMockAgentAdapter, createStubEchoClaude, getRecord } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  const port = createStubImpPort();

  return { port };
}

test("it runs a sub-session on its parent's target as another session in its parent's imp", async () => {
  const ctx = setupTest();

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
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(
              ctx.port,
              { guestDir: join(paths.directory, id) },
              { version: '1.0.0' },
            ),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  const imps = ctx.port.collectImpNames();
  const names = ctx.port.sessionRequests.map((request) => request.name);

  // Each distinct session the imp was asked to start, once.
  const sessions = [...new Set(ctx.port.sessionRequests.map((request) => request.session))];

  expect<readonly unknown[]>(imps).toStrictEqual([expect.any(String)]);
  expect<readonly unknown[]>(names).toStrictEqual([imps[0], imps[0]]);
  expect<readonly unknown[]>(sessions).toStrictEqual([expect.any(String), expect.any(String)]);
});

test("it puts a parent's imp to sleep once its only session is killed", async () => {
  const ctx = setupTest();

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
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(
              ctx.port,
              { guestDir: join(paths.directory, id) },
              { version: '1.0.0' },
            ),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const [imp] = ctx.port.collectImpNames();

  await daemon.client.sendRequest('session.kill', {
    session: getRecord(parent, 'session')['id'],
  });

  expect(ctx.port.findState(String(imp))).toBe('sleeping');
});

test("it wakes a sleeping parent's imp to start a sub-session there", async () => {
  const ctx = setupTest();

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
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(
              ctx.port,
              { guestDir: join(paths.directory, id) },
              { version: '1.0.0' },
            ),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const [imp] = ctx.port.collectImpNames();

  await daemon.client.sendRequest('session.kill', { session: parentID });

  const before = ctx.port.findState(String(imp));

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: parentID,
  });

  expect(before).toBe('sleeping');
  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([imp]);
  expect(ctx.port.findState(String(imp))).toBe('running');
});

test('it gives a sub-session without a target a host of its own on the default target', async () => {
  const ctx = setupTest();

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
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(
              ctx.port,
              { guestDir: join(paths.directory, id) },
              { version: '1.0.0' },
            ),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(getRecord(getRecord(child, 'session'), 'locator')).toMatchObject({ targetID: 'local' });
  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([expect.any(String)]);
  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([expect.anything()]);
});

test('it gives a sub-session on another imp target an imp of its own', async () => {
  const ctx = setupTest();

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
          ...['box', 'other'].map((id) => ({
            id,
            kind: 'imp',
            options: { image: id },
            identity: `imp:${id}`,
            provider: new ImpProvider(
              ctx.port,
              { guestDir: join(paths.directory, id) },
              { version: '1.0.0' },
            ),
          })),
        ],
        defaultTarget: 'local',
      };
    },
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
    target: 'other',
    parent: getRecord(parent, 'session')['id'],
  });

  expect(ctx.port.collectImpNames()).toHaveLength(2);
});
