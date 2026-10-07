import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

test("it runs a sub-session on its parent's target as another session in its parent's imp", async () => {
  // Three targets: `local` on the daemon's machine, the default, and two
  // imp targets, `box` and `other`, over one fixture imp port, so every imp
  // either one makes lists in the same place.
  using port = new FixtureImpPort();

  await using daemon = await startTestDaemon({
    options: (paths) => {
      // Every session runs an agent that stays up reading its input, on
      // any target.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  const imps = port.collectImpNames();
  const names = port.sessionRequests.map((request) => request.name);

  const sessions = new Set(port.sessionRequests.map((request) => request.session));

  expect<Record<string, unknown>>({ imps, names, sessions: sessions.size }).toStrictEqual({
    imps: [expect.any(String)],
    names: [imps[0], imps[0]],
    sessions: 2,
  });
});

test("it puts a parent's imp to sleep once its only session is killed", async () => {
  // Three targets: `local` on the daemon's machine, the default, and two
  // imp targets, `box` and `other`, over one fixture imp port, so every imp
  // either one makes lists in the same place.
  using port = new FixtureImpPort();

  await using daemon = await startTestDaemon({
    options: (paths) => {
      // Every session runs an agent that stays up reading its input, on
      // any target.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const [imp] = port.collectImpNames();

  await daemon.client.sendRequest('session.kill', {
    session: getRecord(parent, 'session')['id'],
  });

  expect(port.findState(String(imp))).toBe('sleeping');
});

test("it wakes a sleeping parent's imp to start a sub-session there", async () => {
  // Three targets: `local` on the daemon's machine, the default, and two
  // imp targets, `box` and `other`, over one fixture imp port, so every imp
  // either one makes lists in the same place.
  using port = new FixtureImpPort();

  await using daemon = await startTestDaemon({
    options: (paths) => {
      // Every session runs an agent that stays up reading its input, on
      // any target.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const [imp] = port.collectImpNames();

  await daemon.client.sendRequest('session.kill', { session: parentID });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: parentID,
  });

  expect<Record<string, unknown>>({
    imps: port.collectImpNames(),
    state: port.findState(String(imp)),
  }).toStrictEqual({ imps: [imp], state: 'running' });
});

test('it gives a sub-session without a target a host of its own on the default target', async () => {
  // Three targets: `local` on the daemon's machine, the default, and two
  // imp targets, `box` and `other`, over one fixture imp port, so every imp
  // either one makes lists in the same place.
  using port = new FixtureImpPort();

  await using daemon = await startTestDaemon({
    options: (paths) => {
      // Every session runs an agent that stays up reading its input, on
      // any target.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  expect({
    locator: getRecord(getRecord(child, 'session'), 'locator'),
    imps: port.collectImpNames(),
    requests: port.sessionRequests,
  }).toMatchObject({
    locator: { targetID: 'local' },
    imps: [expect.any(String)],
    requests: [expect.anything()],
  });
});

test('it gives a sub-session on another imp target an imp of its own', async () => {
  // Three targets: `local` on the daemon's machine, the default, and two
  // imp targets, `box` and `other`, over one fixture imp port, so every imp
  // either one makes lists in the same place.
  using port = new FixtureImpPort();

  await using daemon = await startTestDaemon({
    options: (paths) => {
      // Every session runs an agent that stays up reading its input, on
      // any target.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'other',
    parent: getRecord(parent, 'session')['id'],
  });

  expect(port.collectImpNames()).toHaveLength(2);
});
