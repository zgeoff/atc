import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { DaemonClient } from '../client/daemon-client';
import { buildPrincipalCaller } from '../mcp/build-principal-caller';
import { ReconnectingCaller } from '../mcp/reconnecting-caller';
import { runTool } from '../mcp/run-tool';
import { DaemonError } from '../protocol/daemon-error';
import { encodeCursor } from '../protocol/encode-cursor';
import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import { collectPrincipals } from '../shared/collect-principals';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { buildStubAttentionAdapter } from '../test-utils/build-stub-attention-adapter';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { buildStubHostHold } from '../test-utils/build-stub-host-hold';
import { buildStubTargets } from '../test-utils/build-stub-targets';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { startStubStalledClient } from '../test-utils/start-stub-stalled-client';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { trySendRequest } from '../test-utils/try-send-request';
import { waitFor } from '../test-utils/wait-for';

test('it refuses a client a configured target other than local when the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'box' }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });

  expect(harnesses).toStrictEqual([]);
});

test('it lets a client spawn on the local target when the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local' },
    'client-a',
  );

  expect(harnesses).toStrictEqual(['local']);
});

test('it refuses a client a local spawn when the local target holds other options and the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets({ local: { provider: 'local-pty', shell: 'zsh' } }, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a client a spawn without a target when the local target holds other options and the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets({ local: { provider: 'local-pty', shell: 'zsh' } }, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: daemon.dir }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it hides from a client a session on a local target that holds other options when the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets({ local: { provider: 'local-pty', shell: 'zsh' } }, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const idSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const id = String(getRecord(idSpawned, 'session')['id']);

  expect(
    daemon.client.sendRequest('session.get', { session: id }, 'client-a'),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it lists a client no session on a local target that holds other options when the config has no principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets({ local: { provider: 'local-pty', shell: 'zsh' } }, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toStrictEqual({ sessions: [] });
  expect(harnesses).toStrictEqual(['local']);
});

test('it gives a client the implicit local target when the config has no targets or principals', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir }, 'client-a');
  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toMatchObject({ sessions: [{ id: getRecord(spawned, 'session')['id'] }] });
  expect(harnesses).toStrictEqual(['local']);
});

test.each([
  ['a principal the config does not hold', 'client-c'],
  ['a principal granted an empty list', 'client-b'],
])('it refuses a spawn to %s', async (_label, principal) => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          'client-a': { targets: ['local', 'box'] },
          'client-b': { targets: [] },
        }).principals,
      };
    },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: daemon.dir }, principal),
  ).rejects.toMatchObject({ code: 'target_forbidden' });

  expect(harnesses).toStrictEqual([]);
});

test.each([
  ['a principal the config does not hold', 'client-c'],
  ['a principal granted an empty list', 'client-b'],
])('it lists %s no target and no session', async (_label, principal) => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          'client-a': { targets: ['local', 'box'] },
          'client-b': { targets: [] },
        }).principals,
      };
    },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const listed = await daemon.client.sendRequest('session.list', {}, principal);
  const agents = await daemon.client.sendRequest('agents.list', {}, principal);

  expect(listed).toStrictEqual({ sessions: [] });
  expect(agents).toMatchObject({ targets: [], spawnDefaults: { target: null } });
});

test.each([
  ['session.get', {}],
  ['session.read', {}],
  ['session.screen', {}],
  ['session.attach', { cols: 80, rows: 24 }],
  ['session.input', { d: 'go\r' }],
  ['session.submit', { text: 'go' }],
  ['session.message', { from: 'remote', text: 'hello' }],
  ['session.kill', {}],
  ['session.forget', {}],
  ['session.forget', { confirmToken: 'a-token' }],
  ['session.update', { name: 'renamed' }],
  ['session.update', { pinned: true }],
  ['session.ack', {}],
  ['session.adopt', { cols: 80, rows: 24 }],
  ['session.eject', { prompt: 'carry on' }],
  ['session.resumeCommand', {}],
  ['session.tap', {}],
  ['session.resize', { cols: 80, rows: 24 }],
  ['session.detach', {}],
  ['message.ack', { message: 'a-message' }],
  ['events.read', { waitMs: 0 }],
] as const)(
  'it answers %s with %j for a session on a target outside the principal as for a session that does not exist',
  async (method, params) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: `a-${randomUUID()}`,
    });

    const hidden = String(getRecord(hiddenSpawned, 'session')['id']);
    const missing = randomUUID();

    // The hidden session has a trail of its own, so a read that reached it
    // would differ.
    await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

      expect(JSON.stringify(owner)).toContain(hidden);
    });

    const answered = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: hidden }, 'narrow'),
      hidden,
    );

    const unknown = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: missing }, 'narrow'),
      missing,
    );

    const listed = await daemon.client.sendRequest('session.list');

    expect(answered).toStrictEqual(unknown);

    expect(listed).toStrictEqual({
      sessions: expect.toIncludeSamePartialMembers(
        [hidden].map((id) => ({ id, name: basename(daemon.dir), alive: true, pinned: false })),
      ),
    });

    expect(harnesses).toStrictEqual(['box']);
  },
);

test('it answers a spawn under a session on a target outside the principal as under a session that does not exist', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);
  const missing = randomUUID();

  // The hidden session has a trail of its own, so a read that reached it
  // would differ.
  await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  const answered = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: hidden },
        'narrow',
      ),
    hidden,
  );

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: missing },
        'narrow',
      ),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSamePartialMembers(
      [hidden].map((id) => ({ id, name: basename(daemon.dir), alive: true, pinned: false })),
    ),
  });

  expect(harnesses).toStrictEqual(['box']);
});

test.each([
  ['session.get', {}],
  ['session.read', {}],
  ['session.screen', {}],
  ['session.attach', { cols: 80, rows: 24 }],
  ['session.input', { d: 'go\r' }],
  ['session.submit', { text: 'go' }],
  ['session.message', { from: 'remote', text: 'hello' }],
  ['session.kill', {}],
  ['session.forget', {}],
  ['session.forget', { confirmToken: 'a-token' }],
  ['session.update', { name: 'renamed' }],
  ['session.update', { pinned: true }],
  ['session.ack', {}],
  ['session.adopt', { cols: 80, rows: 24 }],
  ['session.eject', { prompt: 'carry on' }],
  ['session.resumeCommand', {}],
  ['session.tap', {}],
  ['session.resize', { cols: 80, rows: 24 }],
  ['session.detach', {}],
  ['message.ack', { message: 'a-message' }],
  ['events.read', { waitMs: 0 }],
] as const)(
  'it answers %s with %j for a parent whose sub-session is on a target outside the principal as for a session that does not exist',
  async (method, params) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
      resume: `a-${randomUUID()}`,
    });

    const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

    const childSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: `a-${randomUUID()}`,
      parent: hidden,
    });

    const child = String(getRecord(childSpawned, 'session')['id']);
    const missing = randomUUID();

    // The hidden session has a trail of its own, so a read that reached it
    // would differ.
    await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

      expect(JSON.stringify(owner)).toContain(hidden);
    });

    const answered = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: hidden }, 'narrow'),
      hidden,
    );

    const unknown = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: missing }, 'narrow'),
      missing,
    );

    const listed = await daemon.client.sendRequest('session.list');

    expect(answered).toStrictEqual(unknown);

    expect(listed).toStrictEqual({
      sessions: expect.toIncludeSamePartialMembers(
        [hidden, child].map((id) => ({
          id,
          name: basename(daemon.dir),
          alive: true,
          pinned: false,
        })),
      ),
    });

    expect(harnesses).toStrictEqual(['local', 'box']);
  },
);

test('it answers a spawn under a parent whose sub-session is on a target outside the principal as under a session that does not exist', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent: hidden,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);
  const missing = randomUUID();

  // The hidden session has a trail of its own, so a read that reached it
  // would differ.
  await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  const answered = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: hidden },
        'narrow',
      ),
    hidden,
  );

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: missing },
        'narrow',
      ),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSamePartialMembers(
      [hidden, child].map((id) => ({ id, name: basename(daemon.dir), alive: true, pinned: false })),
    ),
  });

  expect(harnesses).toStrictEqual(['local', 'box']);
});

test.each([
  ['session.get', {}],
  ['session.read', {}],
  ['session.screen', {}],
  ['session.attach', { cols: 80, rows: 24 }],
  ['session.input', { d: 'go\r' }],
  ['session.submit', { text: 'go' }],
  ['session.message', { from: 'remote', text: 'hello' }],
  ['session.kill', {}],
  ['session.forget', {}],
  ['session.forget', { confirmToken: 'a-token' }],
  ['session.update', { name: 'renamed' }],
  ['session.update', { pinned: true }],
  ['session.ack', {}],
  ['session.adopt', { cols: 80, rows: 24 }],
  ['session.eject', { prompt: 'carry on' }],
  ['session.resumeCommand', {}],
  ['session.tap', {}],
  ['session.resize', { cols: 80, rows: 24 }],
  ['session.detach', {}],
  ['message.ack', { message: 'a-message' }],
  ['events.read', { waitMs: 0 }],
] as const)(
  'it answers %s with %j for a sub-session whose parent is on a target outside the principal as for a session that does not exist',
  async (method, params) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const rootSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: `a-${randomUUID()}`,
    });

    const root = String(getRecord(rootSpawned, 'session')['id']);

    const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
      resume: `a-${randomUUID()}`,
      parent: root,
    });

    const hidden = String(getRecord(hiddenSpawned, 'session')['id']);
    const missing = randomUUID();

    // The hidden session has a trail of its own, so a read that reached it
    // would differ.
    await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

      expect(JSON.stringify(owner)).toContain(hidden);
    });

    const answered = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: hidden }, 'narrow'),
      hidden,
    );

    const unknown = await trySendRequest(
      () => daemon.client.sendRequest(method, { ...params, session: missing }, 'narrow'),
      missing,
    );

    const listed = await daemon.client.sendRequest('session.list');

    expect(answered).toStrictEqual(unknown);

    expect(listed).toStrictEqual({
      sessions: expect.toIncludeSamePartialMembers(
        [root, hidden].map((id) => ({
          id,
          name: basename(daemon.dir),
          alive: true,
          pinned: false,
        })),
      ),
    });

    expect(harnesses).toStrictEqual(['box', 'local']);
  },
);

test('it answers a spawn under a sub-session whose parent is on a target outside the principal as under a session that does not exist', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const rootSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const root = String(getRecord(rootSpawned, 'session')['id']);

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
    parent: root,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);
  const missing = randomUUID();

  // The hidden session has a trail of its own, so a read that reached it
  // would differ.
  await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  const answered = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: hidden },
        'narrow',
      ),
    hidden,
  );

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: missing },
        'narrow',
      ),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSamePartialMembers(
      [root, hidden].map((id) => ({ id, name: basename(daemon.dir), alive: true, pinned: false })),
    ),
  });

  expect(harnesses).toStrictEqual(['box', 'local']);
});

test('it answers permission.respond for a request of a session outside the principal as for an unknown request', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const events: EventMsg[] = [];

  daemon.client.onEvent = (event) => {
    events.push(event);
  };

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  await daemon.sendHookLines({ atcId: hidden, event: 'Notification', payload: {} });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'PermissionRequested', s: hidden });
  });

  const request = z
    .object({ request: z.string() })
    .parse(events.find((event) => event.ev === 'PermissionRequested')).request;

  const missing = randomUUID();

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('permission.respond', { request, decision: 'allow' }, 'narrow'),
    request,
  );

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'permission.respond',
        { request: missing, decision: 'allow' },
        'narrow',
      ),
    missing,
  );

  expect(answered).toStrictEqual(unknown);
});

test('it refuses a principal a workspace spawn on a target it may not use for the target alone', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const refused = daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'box', workspace: { kind: 'path', path: daemon.dir } },
    'narrow',
  );

  expect(refused).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });
  expect(harnesses).toBeEmpty();
});

test('it lists a principal only the directories of spawns on targets it may use', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const boxDir = join(daemon.dir, 'on-box');
  const localDir = join(daemon.dir, 'on-local');

  mkdirSync(boxDir);
  mkdirSync(localDir);

  await daemon.client.sendRequest('session.spawn', { cwd: boxDir, target: 'box' });
  await daemon.client.sendRequest('session.spawn', { cwd: localDir, target: 'local' });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('dirs.list');

    expect(owner).toStrictEqual({ dirs: [localDir, boxDir] });
  });

  const listed = await daemon.client.sendRequest('dirs.list', {}, 'narrow');

  expect(listed).toStrictEqual({ dirs: [localDir] });
});

test('it lists a principal only the fleet entries of sessions on targets it may use', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('fleet.list');

    expect(owner).toMatchObject({
      fleet: expect.toIncludeSameMembers([
        expect.objectContaining({ sessionID: shown }),
        expect.objectContaining({ sessionID: hidden }),
      ]),
    });
  });

  const listed = await daemon.client.sendRequest('fleet.list', {}, 'narrow');

  expect(listed).toStrictEqual({ fleet: [expect.objectContaining({ sessionID: shown })] });
});

test('it keeps the events of a hidden session from a principal whose exited session holds the same agent session id', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const earlier = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: agentSessionID,
  });

  await daemon.client.sendRequest('session.kill', {
    session: getRecord(earlier, 'session')['id'],
  });

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

  expect(read).toStrictEqual({ events: [], more: false, cursor: expect.anything() });
});

test('it keeps the messages of a hidden session from a principal whose exited session holds the same agent session id', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const earlier = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: agentSessionID,
  });

  await daemon.client.sendRequest('session.kill', {
    session: getRecord(earlier, 'session')['id'],
  });

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: sent['message'] }, 'narrow'),
    String(sent['message']),
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: 'no-such-message' }, 'narrow'),
    'no-such-message',
  );

  expect(answered).toStrictEqual(unknown);
});

test('it keeps the events of a hidden session from the full trail of a principal whose live session resumes the same agent session', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const all = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

  expect(JSON.stringify(all)).not.toInclude('box');
  expect(JSON.stringify(all)).not.toInclude(hidden);
});

test('it keeps the events of a hidden session from the trail a principal reads for its own session that resumes the same agent session', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const filtered = await daemon.client.sendRequest(
    'events.read',
    { session: shown, waitMs: 0 },
    'narrow',
  );

  expect(JSON.stringify(filtered)).not.toInclude('box');
});

test('it keeps the messages of a hidden session from a principal whose live session resumes the same agent session', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: sent['message'] }, 'narrow'),
    String(sent['message']),
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: 'no-such-message' }, 'narrow'),
    'no-such-message',
  );

  expect(answered).toStrictEqual(unknown);
});

test('it keeps the activity of a hidden session out of the last activity of a principal session that resumes the same agent session', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: {
      session_id: agentSessionID,
      message: 'box-only detail',
    },
  });

  await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const got = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  expect(got['lastActivityAt']).toBe(getRecord(own, 'session')['createdAt']);
});

test("it lists a principal no message of a hidden session that one turn answered with its own session's", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  const toHidden = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  const toShown = await daemon.client.sendRequest('session.message', {
    session: shown,
    from: 'owner',
    text: 'local message',
  });

  await daemon.sendHookLines({
    atcId: shown,
    event: 'Report',
    payload: {
      kind: 'answered',
      messages: [toHidden['message'], toShown['message']],
      answer: 'both',
      turn: 't-1',
    },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: toShown['message'] });

    expect(got['status']).toBe('answered');
  });

  const ownerGot = await daemon.client.sendRequest('message.get', { message: toShown['message'] });

  const principalGot = await daemon.client.sendRequest(
    'message.get',
    { message: toShown['message'] },
    'narrow',
  );

  expect(ownerGot).toMatchObject({ turn: 't-1', answeredWith: [toHidden['message']] });
  expect(principalGot).toMatchObject({ turn: 't-1', answeredWith: [] });
});

test('it keeps the activity of a forgotten hidden session out of a principal session that shares its agent session id', async () => {
  const harnesses: string[] = [];
  const clock = buildStubClock(1_700_000_000_000);

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        clock,
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const earlier = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: agentSessionID,
  });

  const shown = String(getRecord(earlier, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: shown });

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const before = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  // The hidden session's event lands a minute after anything the shown
  // session holds, so a leak would change what the principal reads.
  clock.advance(60_000);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Notification',
    payload: { session_id: agentSessionID },
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  await daemon.client.sendRequest('session.kill', { session: hidden });
  await daemon.client.sendRequest('session.kill', { session: hidden });

  const after = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  expect(after['lastActivityAt']).toBe(before['lastActivityAt']);
});

test.each([
  ['a parent whose sub-session is on a target outside the principal', ['local', 'box']],
  ['a sub-session whose parent is on a target outside the principal', ['box', 'local']],
])(
  'it leaves the whole tree of %s out of the lists and the trail',
  async (_label, [rootTarget = 'local', childTarget = 'local']) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const shownSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
      resume: `a-${randomUUID()}`,
    });

    const shown = String(getRecord(shownSpawned, 'session')['id']);

    const rootSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: rootTarget,
      resume: `a-${randomUUID()}`,
    });

    const root = String(getRecord(rootSpawned, 'session')['id']);

    const childSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: childTarget,
      resume: `a-${randomUUID()}`,
      parent: root,
    });

    const child = String(getRecord(childSpawned, 'session')['id']);

    await daemon.sendHookLines({ atcId: root, event: 'UserPromptSubmit', payload: {} });
    await daemon.sendHookLines({ atcId: child, event: 'UserPromptSubmit', payload: {} });
    await daemon.sendHookLines({ atcId: shown, event: 'UserPromptSubmit', payload: {} });

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });
      const fleet = await daemon.client.sendRequest('fleet.list');

      expect(JSON.stringify(owner)).toIncludeMultiple([root, child, shown]);
      expect(getRecord(fleet, 'fleet')).toHaveLength(3);
    });

    const listed = await daemon.client.sendRequest('session.list', {}, 'narrow');
    const fleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

    expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id: shown })] });
    expect(fleet).toStrictEqual({ fleet: [expect.objectContaining({ sessionID: shown })] });
    expect(JSON.stringify(read)).toInclude(shown);
    expect(JSON.stringify(listed)).not.toInclude(root);
    expect(JSON.stringify(fleet)).not.toInclude(root);
    expect(JSON.stringify(read)).not.toInclude(root);
    expect(JSON.stringify(listed)).not.toInclude(child);
    expect(JSON.stringify(fleet)).not.toInclude(child);
    expect(JSON.stringify(read)).not.toInclude(child);
  },
);

test.each([
  ['a parent whose sub-session is on a target outside the principal', ['local', 'box']],
  ['a sub-session whose parent is on a target outside the principal', ['box', 'local']],
])(
  'it pushes a principal connection no event of the tree of %s',
  async (_label, [rootTarget = 'local', childTarget = 'local']) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const rootSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: rootTarget,
      resume: `a-${randomUUID()}`,
    });

    const root = String(getRecord(rootSpawned, 'session')['id']);

    const childSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: childTarget,
      resume: `a-${randomUUID()}`,
      parent: root,
    });

    const child = String(getRecord(childSpawned, 'session')['id']);

    const client = await daemon.openClient({ principal: 'narrow' });

    const events: EventMsg[] = [];

    client.onEvent = (event) => {
      events.push(event);
    };

    const shownSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
      resume: `a-${randomUUID()}`,
    });

    const shown = String(getRecord(shownSpawned, 'session')['id']);

    await daemon.sendHookLines({ atcId: root, event: 'Notification', payload: {} });
    await daemon.sendHookLines({ atcId: child, event: 'Notification', payload: {} });
    await daemon.client.sendRequest('session.update', { session: root, name: 'renamed' });
    await daemon.client.sendRequest('session.kill', { session: root });
    await daemon.client.sendRequest('session.kill', { session: root });
    await daemon.client.sendRequest('session.kill', { session: shown });
    await daemon.client.sendRequest('session.kill', { session: shown });

    await waitFor(() => {
      expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: shown });
    });

    expect(
      events.filter((event) => event.ev === 'SessionAdded').map((event) => event['session']),
    ).toPartiallyContain({ id: shown });

    expect(JSON.stringify(events)).not.toInclude(root);
    expect(JSON.stringify(events)).not.toInclude(child);
  },
);

test('it shows a principal a parent leaving when an out-of-reach sub-session joins it as when the owner forgets it', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const forgotHarnesses: string[] = [];

  const forgot = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: forgotHarnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const joinedParentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const joinedParent = String(getRecord(joinedParentSpawned, 'session')['id']);

  const forgotParentSpawned = await forgot.client.sendRequest('session.spawn', {
    cwd: forgot.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const forgotParent = String(getRecord(forgotParentSpawned, 'session')['id']);

  await forgot.client.sendRequest('session.kill', { session: forgotParent });

  const joinedClient = await daemon.openClient({ principal: 'narrow' });
  const forgotClient = await forgot.openClient({ principal: 'narrow' });

  const joinedEvents: EventMsg[] = [];
  const forgotEvents: EventMsg[] = [];

  joinedClient.onEvent = (event) => {
    joinedEvents.push(event);
  };

  forgotClient.onEvent = (event) => {
    forgotEvents.push(event);
  };

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent: joinedParent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  await forgot.client.sendRequest('session.forget', { session: forgotParent });

  await waitFor(() => {
    expect(joinedEvents).toPartiallyContain({ ev: 'SessionRemoved' });
    expect(forgotEvents).toPartiallyContain({ ev: 'SessionRemoved' });
  });

  await waitFor(async () => {
    const fleet = await forgot.client.sendRequest('fleet.list');

    expect(fleet).toStrictEqual({ fleet: [] });
  });

  const joinedSessions = await joinedClient.sendRequest('session.list');
  const joinedFleet = await joinedClient.sendRequest('fleet.list');
  const forgotSessions = await forgotClient.sendRequest('session.list');
  const forgotFleet = await forgotClient.sendRequest('fleet.list');

  expect(JSON.stringify(forgotEvents).replaceAll(forgotParent, '<parent>')).toBe(
    JSON.stringify(joinedEvents).replaceAll(joinedParent, '<parent>'),
  );

  expect(JSON.stringify(forgotSessions).replaceAll(forgotParent, '<parent>')).toBe(
    JSON.stringify(joinedSessions).replaceAll(joinedParent, '<parent>'),
  );

  expect(JSON.stringify(forgotFleet).replaceAll(forgotParent, '<parent>')).toBe(
    JSON.stringify(joinedFleet).replaceAll(joinedParent, '<parent>'),
  );

  expect(forgotEvents).toStrictEqual([{ v: PROTOCOL_V, ev: 'SessionRemoved', s: forgotParent }]);
  expect(forgotSessions).toStrictEqual({ sessions: [] });
  expect(forgotFleet).toStrictEqual({ fleet: [] });
  expect(JSON.stringify(joinedEvents)).not.toInclude(child);
  expect(JSON.stringify(joinedSessions)).not.toInclude(child);
  expect(JSON.stringify(joinedFleet)).not.toInclude(child);
});

test('it pushes a principal that sees the whole tree only the removal of a forgotten parent', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  const client = await daemon.openClient({ principal: 'wide' });

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await daemon.client.sendRequest('session.forget', { session: parent });

  const listed = await client.sendRequest('session.list');

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: parent });
  });

  expect(events.filter((event) => event.ev === 'SessionRemoved')).toStrictEqual([
    { v: PROTOCOL_V, ev: 'SessionRemoved', s: parent },
  ]);

  expect(events.filter((event) => event.ev === 'SessionAdded')).toBeEmpty();
  expect(listed).toMatchObject({ sessions: [{ id: child, alive: true }] });
  expect(JSON.stringify(listed)).not.toInclude(parent);
});

test('it takes the inbox tap from a principal connection whose tapped session leaves its view', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const client = await daemon.openClient({ principal: 'narrow' });

  const events: EventMsg[] = [];
  const ownerEvents: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  daemon.client.onEvent = (event) => {
    ownerEvents.push(event);
  };

  await client.sendRequest('session.tap', { session: parent });

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: parent });
  });

  await daemon.client.sendRequest('session.forget', { session: child });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionAdded' });
  });

  await daemon.client.sendRequest('session.message', {
    session: parent,
    from: 'owner',
    text: 'for the tap',
  });

  await daemon.client.sendRequest('session.tap', { session: parent });

  await waitFor(() => {
    expect(ownerEvents).toPartiallyContain({ ev: 'InboxMessage', text: 'for the tap' });
  });

  expect(events).not.toPartiallyContain({ ev: 'InboxMessage' });
});

test('it hides from a principal a restored sub-session of a hidden parent', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const hiddenParentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hiddenParent = String(getRecord(hiddenParentSpawned, 'session')['id']);

  const hiddenChildSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
    parent: hiddenParent,
  });

  const hiddenChild = String(getRecord(hiddenChildSpawned, 'session')['id']);

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({
        narrow: { targets: ['local'] },
        wide: { targets: ['local', 'box'] },
      }).principals,
    };
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const owner = await daemon.client.sendRequest('session.list');
  const listed = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const fleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');

  expect(owner).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([{ id: hiddenChild, parent: hiddenParent }]),
  });

  expect(listed).toMatchObject({ sessions: [{ id: shown }] });
  expect(fleet).toMatchObject({ fleet: [{ sessionID: shown }] });
});

test('it kills only the sub-sessions a principal could see when the kill began', async () => {
  const host = buildStubHostHold();
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, {
          spawned: harnesses,
          hosts: {
            local: {
              capabilities: { suspend: true },
              suspendHost: host.hold,
            },
          },
        }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  host.arm();

  // A held host operation would keep the daemon's stop waiting.
  const releaseHost = registerTestCleanup(() => {
    host.release();
  });

  const killed = daemon.client.sendRequest('session.kill', { session: parent }, 'narrow');

  await host.entered;

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  releaseHost();

  await killed;

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([
      { id: parent, alive: false },
      { id: child, alive: true, parent },
    ]),
  });
});

test('it spawns a principal that may see the parent beside the sub-session it asks for', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', parent: child, resume: `a-${randomUUID()}` },
    'wide',
  );

  expect(getRecord(spawned, 'session')['parent']).toBe(parent);
});

test('it lets a principal forget a session on a target it may use', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  const forgotten = await daemon.client.sendRequest('session.forget', { session: shown }, 'narrow');

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it answers a forget of a dead session with a dead sub-session out of reach as for a session that does not exist, forgetting nothing', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);
  const missing = randomUUID();

  await daemon.client.sendRequest('session.kill', { session: parent });

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('session.forget', { session: parent }, 'narrow'),
    parent,
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('session.forget', { session: missing }, 'narrow'),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it leaves the events of a session outside the principal out of an unfiltered read', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  await daemon.sendHookLines({ atcId: hidden, event: 'UserPromptSubmit', payload: {} });
  await daemon.sendHookLines({ atcId: shown, event: 'UserPromptSubmit', payload: {} });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'client-a');

  expect(JSON.stringify(read)).not.toContain(hidden);
  expect(JSON.stringify(read)).toContain(shown);
});

test('it answers a report of a session outside the principal as a report that does not exist', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Report',
    payload: { kind: 'note', label: 'l', text: 'secret plan' },
  });

  const eventEntry = z.object({ cursor: z.string() });
  const eventList = z.object({ events: z.tuple([eventEntry], z.unknown()) });

  const event = await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    return eventList.parse(owner).events[0];
  });

  const cursor = event.cursor;
  const missing = encodeCursor({ kind: 'events', id: 999_999 });

  const owner = await daemon.client.sendRequest('report.get', { report: cursor });

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('report.get', { report: cursor }, 'client-a'),
    cursor,
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('report.get', { report: missing }, 'client-a'),
    missing,
  );

  expect(owner).toMatchObject({ session: hidden, text: 'secret plan' });
  expect(answered).toStrictEqual(unknown);
});

test('it gives a principal the report of a session it may see', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  await daemon.sendHookLines({
    atcId: shown,
    event: 'Report',
    payload: { kind: 'note', label: 'l', text: 'open plan' },
  });

  const eventEntry = z.object({ cursor: z.string() });
  const eventList = z.object({ events: z.tuple([eventEntry], z.unknown()) });

  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'client-a');

    return eventList.parse(read).events[0];
  });

  const report = await daemon.client.sendRequest(
    'report.get',
    { report: event.cursor },
    'client-a',
  );

  expect(report).toMatchObject({ session: shown, text: 'open plan', complete: true });
});

test('it reads the whole text of only the reports of sessions a principal may see in one events read', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  await daemon.sendHookLines({
    atcId: hidden,
    event: 'Report',
    payload: { kind: 'note', label: 'l', text: 'secret plan' },
  });

  await daemon.sendHookLines({
    atcId: shown,
    event: 'Report',
    payload: { kind: 'note', label: 'l', text: 'open plan' },
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('open plan');
    expect(JSON.stringify(owner)).toContain('secret plan');
  });

  const read = await runTool(
    buildPrincipalCaller(caller, 'client-a'),
    'atc_events_read',
    { reportText: true },
    { callerSessionID: null, sender: { kind: 'fixed', name: 'client-a' } },
  );

  expect(read.text).not.toContain('secret plan');
  expect(read.text).not.toContain(hidden);

  expect(read.structured).toMatchObject({
    events: [{ kind: 'report', session: shown, text: 'open plan', complete: true }],
    more: false,
  });
});

test('it reads the first of many large reports a principal may see while another connection never reads', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets({ local: { provider: 'local-pty' } }, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  // A connection that reads its handshake answer and then stops reading, so
  // whatever the daemon sends it backs up.
  const slow = await startStubStalledClient(daemon.socketPath, 'atc/test-build');

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  await daemon.sendHookLines(
    ...Array.from({ length: 50 }, (_, index) => ({
      atcId: shown,
      event: 'Report',
      payload: { kind: 'note', label: 'l', text: String(index).padEnd(60_000, 'x') },
    })),
  );

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { limit: 50 });

    expect(owner['events']).toBeArrayOfSize(50);
  });

  const read = await runTool(
    buildPrincipalCaller(caller, 'client-a'),
    'atc_events_read',
    { limit: 50, reportText: true },
    { callerSessionID: null, sender: { kind: 'fixed', name: 'client-a' } },
  );

  expect(slow.chunks).toBeArrayOfSize(1);

  expect(read.structured).toMatchObject({
    events: [{ kind: 'report', session: shown, text: '0'.padEnd(60_000, 'x'), complete: true }],
    more: true,
  });
});

test('it names a report by the session that sent it, never a hidden session that resumes the same agent session', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  await daemon.sendHookLines({
    atcId: shown,
    event: 'Report',
    payload: { kind: 'note', label: 'l', text: 'open plan' },
  });

  const eventEntry = z.object({ cursor: z.string() });
  const eventList = z.object({ events: z.tuple([eventEntry], z.unknown()) });

  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

    return eventList.parse(read).events[0];
  });

  const report = await daemon.client.sendRequest('report.get', { report: event.cursor }, 'narrow');

  expect(report).toMatchObject({ session: shown, text: 'open plan' });
  expect(JSON.stringify(report)).not.toInclude(hidden);
});

test('it narrows a request on an owner connection to the principal it acts as', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  const narrow = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const wide = await daemon.client.sendRequest('session.list', {}, 'wide');

  expect(narrow).toMatchObject({ sessions: [{ id: shown }] });
  expect(getRecord(narrow, 'sessions')).toHaveLength(1);
  expect(wide).toMatchObject({ sessions: [{ id: shown }, { id: hidden }] });
});

test('it lists a connection only the reach of the principal it acts as when a request asks for a wider one', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const client = await daemon.openClient({ principal: 'narrow' });
  const own = await client.sendRequest('session.list');
  const widened = await client.sendRequest('session.list', {}, 'wide');

  expect(own).toMatchObject({ sessions: [{ id: shown }] });
  expect(getRecord(own, 'sessions')).toHaveLength(1);
  expect(widened).toStrictEqual(own);
  expect(harnesses).toStrictEqual(['local', 'box']);
});

test('it refuses a connection a spawn on a target only a wider principal than its own may use', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const client = await daemon.openClient({ principal: 'narrow' });

  expect(
    client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'box' }, 'wide'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });

  expect(client.sendRequest('daemon.ping')).resolves.toStrictEqual({});
  expect(harnesses).toStrictEqual([]);
});

test.each(['daemon.quit', 'fleet.restore'])(
  'it refuses a principal connection %s',
  async (method) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const client = await daemon.openClient({ principal: 'narrow' });

    expect(client.sendRequest(method)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(client.sendRequest('daemon.ping')).resolves.toStrictEqual({});
  },
);

test('it pushes a principal connection only the events of sessions it may see', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ narrow: { targets: ['local'] } }).principals,
      };
    },
  });

  const client = await daemon.openClient({ principal: 'narrow' });

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  const shownSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const shown = String(getRecord(shownSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: shown });
  await daemon.client.sendRequest('session.kill', { session: shown });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: shown });
  });

  const added = events.filter((event) => event.ev === 'SessionAdded');

  expect(added).toMatchObject([{ session: { id: shown } }]);
  expect(JSON.stringify(events)).not.toContain(hidden);
});

test('it refuses a handshake whose principal it cannot read', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ narrow: { targets: ['local'] } }).principals,
      };
    },
  });

  expect(daemon.openClient({ principal: 5 })).rejects.toMatchObject({ code: 'bad_args' });
});

test('it answers message.get for a message of a session outside the principal as for an unknown message', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ 'client-a': { targets: ['local'] } }).principals,
      };
    },
  });

  const hiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const hidden = String(getRecord(hiddenSpawned, 'session')['id']);

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'hello',
  });

  const messageID = String(sent['message']);
  const missing = `m-${randomUUID()}`;

  const owner = await daemon.client.sendRequest('message.get', { message: messageID });

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: messageID }, 'client-a'),
    messageID,
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('message.get', { message: missing }, 'client-a'),
    missing,
  );

  expect(owner).toMatchObject({ message: messageID, session: hidden });
  expect(answered).toStrictEqual(unknown);
});

test('it gives each principal a session of its own under the same idempotency key', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const first = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-a',
  );

  const other = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-b',
  );

  expect(getRecord(other, 'session')['id']).not.toBe(getRecord(first, 'session')['id']);
  expect(harnesses).toStrictEqual(['local', 'local']);
});

test("it answers a principal's retry under its idempotency key with its own session when another principal holds the same key", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const first = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-a',
  );

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-b',
  );

  const retried = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-a',
  );

  expect(getRecord(retried, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(harnesses).toStrictEqual(['local', 'local']);
});

test("it refuses a principal's retry under its idempotency key with another payload", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const otherDir = join(daemon.dir, 'other');

  mkdirSync(otherDir);

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-a',
  );

  expect(
    daemon.client.sendRequest(
      'session.spawn',
      { cwd: otherDir, idempotencyKey: 'k-1' },
      'client-a',
    ),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test("it keeps a principal connection out of another principal's idempotency keys", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(undefined, undefined);

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals(undefined).principals,
      };
    },
  });

  const owned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-b',
  );

  const client = await daemon.openClient({ principal: 'client-a' });

  const reached = await client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    'client-b',
  );

  expect(getRecord(reached, 'session')['id']).not.toBe(getRecord(owned, 'session')['id']);
  expect(harnesses).toStrictEqual(['local', 'local']);
});

test('it answers a kill of a session with a sub-session out of reach as for a session that does not exist, killing nothing', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);
  const missing = randomUUID();

  const answered = await trySendRequest(
    () => daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
    parent,
  );

  const unknown = await trySendRequest(
    () => daemon.client.sendRequest('session.kill', { session: missing }, 'narrow'),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: true },
      { id: child, alive: true },
    ],
  });
});

test.each([
  ['the owner', undefined],
  ['a principal that may use every target in it', 'wide'],
])('it lets %s kill a session together with its sub-sessions', async (_label, principal) => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: parent }, principal);

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it answers a second kill of a dead session with a dead sub-session out of reach as for a session that does not exist, removing nothing', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: parent });

  const refused = daemon.client.sendRequest('session.kill', { session: parent }, 'narrow');

  await Promise.allSettled([refused]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it answers a second kill that would move a live sub-session out of reach as for a session that does not exist, moving nothing', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: parent });
  await daemon.client.sendRequest('session.adopt', { session: child, cols: 80, rows: 24 });

  const refused = daemon.client.sendRequest('session.kill', { session: parent }, 'narrow');

  await Promise.allSettled([refused]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: true, parent },
    ],
  });
});

test.each([
  ['a pin', { pinned: true }],
  ['a rename', { name: 'renamed' }],
])(
  'it answers %s of a session with a sub-session out of reach as for a session that does not exist, changing nothing',
  async (_label, change) => {
    const harnesses: string[] = [];

    const daemon = await startTestDaemon({
      options: () => {
        const targets = collectTargets(
          { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
          undefined,
        );

        return {
          adapter: buildStubAttentionAdapter(),
          targets: buildStubTargets(targets.targets, { spawned: harnesses }),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
          principals: collectPrincipals({
            narrow: { targets: ['local'] },
            wide: { targets: ['local', 'box'] },
          }).principals,
        };
      },
    });

    const parentSpawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
      resume: `a-${randomUUID()}`,
    });

    const parent = String(getRecord(parentSpawned, 'session')['id']);

    await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: `a-${randomUUID()}`,
      parent,
    });

    const refused = daemon.client.sendRequest(
      'session.update',
      { session: parent, ...change },
      'narrow',
    );

    await Promise.allSettled([refused]);

    const listed = await daemon.client.sendRequest('session.list');

    expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

    expect(listed).toMatchObject({
      sessions: [{ id: parent, name: basename(daemon.dir), pinned: false }, {}],
    });
  },
);

test('it refuses the replay of a held spawn key once the grant no longer reaches its target', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({
        narrow: { targets: ['local'] },
        wide: { targets: ['local'] },
      }).principals,
    };
  });

  const replayed = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
        'wide',
      ),
    'k-1',
  );

  const fresh = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
        'narrow',
      ),
    'k-1',
  );

  expect(replayed).toStrictEqual(fresh);
  expect(replayed).toMatchObject({ error: { code: 'target_forbidden' } });
  expect(harnesses).toStrictEqual(['box']);
});

test("it refuses the replay of a held spawn key once its session's tree leaves the principal's reach", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'narrow',
  );

  const parent = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const replayed = daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'narrow',
  );

  expect(replayed).rejects.toThrowWithMessage(
    DaemonError,
    "this client may not use execution target 'local'. Grant it to the client under principals in config.json and restart the daemon",
  );

  expect(replayed).rejects.toHaveProperty('code', 'target_forbidden');
  expect(replayed).rejects.toHaveProperty('data', { target: 'local' });
  expect(harnesses).toStrictEqual(['local', 'box']);
});

test("it refuses the replay of a held spawn key after a restart once its stored tree leaves the principal's reach", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'narrow',
  );

  const parent = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({
        narrow: { targets: ['local'] },
        wide: { targets: ['local', 'box'] },
      }).principals,
    };
  });

  const replayed = daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'narrow',
  );

  await Promise.allSettled([replayed]);

  const listed = await daemon.client.sendRequest('session.list', {});

  expect(listed).toStrictEqual({ sessions: [] });

  expect(replayed).rejects.toThrowWithMessage(
    DaemonError,
    "this client may not use execution target 'local'. Grant it to the client under principals in config.json and restart the daemon",
  );

  expect(replayed).rejects.toHaveProperty('code', 'target_forbidden');
  expect(replayed).rejects.toHaveProperty('data', { target: 'local' });
  expect(harnesses).toStrictEqual(['local', 'box']);
});

test("it answers a principal's long poll on a session whose tree leaves its reach as a poll on a session that never existed", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);
  const missing = randomUUID();

  await daemon.client.sendRequest('session.tap', { session: parent });

  const first = await daemon.client.sendRequest(
    'events.read',
    { session: parent, waitMs: 0 },
    'narrow',
  );

  const cursor = first['cursor'];

  const poll = trySendRequest(
    () =>
      daemon.client.sendRequest('events.read', { session: parent, cursor, waitMs: 1000 }, 'narrow'),
    parent,
  );

  await waitFor(() => {
    expect(daemon.daemon.countEventWaiters()).toBe(1);
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  await daemon.client.sendRequest('session.message', {
    session: parent,
    from: 'owner',
    text: 'hidden message',
  });

  const answered = await poll;

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest('events.read', { session: missing, cursor, waitMs: 0 }, 'narrow'),
    missing,
  );

  expect(answered).toStrictEqual(unknown);
  expect(JSON.stringify(answered)).not.toInclude('hidden message');
});

test("it keeps a hidden session's messages from a principal tapping a session that shares its agent session id", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const agentSessionID = `a-${randomUUID()}`;

  const hiddenSpawn = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: agentSessionID,
  });

  const shownSpawn = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(hiddenSpawn, 'session')['id']);
  const shown = String(getRecord(shownSpawn, 'session')['id']);

  await daemon.client.sendRequest('session.tap', { session: hidden });

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'hidden message',
  });

  const message = String(sent['message']);

  const client = await daemon.openClient({ principal: 'narrow' });

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendRequest('session.tap', { session: shown });

  await daemon.client.sendRequest('session.message', {
    session: shown,
    from: 'owner',
    text: 'shown message',
  });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'InboxMessage' });
  });

  const acked = await trySendRequest(
    () => client.sendRequest('message.ack', { session: shown, message }),
    message,
  );

  const unknown = await trySendRequest(
    () => client.sendRequest('message.ack', { session: shown, message: 'm-unknown' }),
    'm-unknown',
  );

  const owner = await daemon.client.sendRequest('message.get', { message });

  expect(events.filter((event) => event.ev === 'InboxMessage')).toMatchObject([
    { s: shown, text: 'shown message' },
  ]);

  expect(acked).toStrictEqual(unknown);
  expect(owner).toMatchObject({ status: 'accepted' });
});

test('it refuses a principal an adopt of a session whose tree leaves its reach while the host wakes', async () => {
  const host = buildStubHostHold();
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, {
          spawned: harnesses,
          hosts: {
            local: {
              prepareHost: host.hold,
            },
          },
        }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);
  const missing = randomUUID();

  await daemon.client.sendRequest('session.kill', { session: parent });

  host.arm();

  // A held host operation would keep the daemon's stop waiting.
  const releaseHost = registerTestCleanup(() => {
    host.release();
  });

  const adopted = trySendRequest(
    () =>
      daemon.client.sendRequest('session.adopt', { session: parent, cols: 80, rows: 24 }, 'narrow'),
    parent,
  );

  await host.entered;

  const childSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  const child = String(getRecord(childSpawned, 'session')['id']);

  releaseHost();

  const answered = await adopted;

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.adopt',
        { session: missing, cols: 80, rows: 24 },
        'narrow',
      ),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);
  expect(harnesses).toStrictEqual(['local', 'box']);

  expect(listed).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([
      { id: parent, alive: false, lastMsg: 'killed' },
      { id: child, alive: true },
    ]),
  });
});

test('it refuses a principal a spawn under a parent whose tree leaves its reach while the host wakes', async () => {
  const host = buildStubHostHold();
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, {
          spawned: harnesses,
          hosts: {
            local: {
              prepareHost: host.hold,
            },
          },
        }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const parentSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const parent = String(getRecord(parentSpawned, 'session')['id']);
  const missing = randomUUID();

  host.arm();

  // A held host operation would keep the daemon's stop waiting.
  const releaseHost = registerTestCleanup(() => {
    host.release();
  });

  const spawned = trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent, resume: `a-${randomUUID()}` },
        'narrow',
      ),
    parent,
  );

  await host.entered;

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
    parent,
  });

  releaseHost();

  const answered = await spawned;

  const unknown = await trySendRequest(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'local', parent: missing, resume: `a-${randomUUID()}` },
        'narrow',
      ),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);
  expect(harnesses).toStrictEqual(['local', 'box']);
  expect(getRecord(listed, 'sessions')).toHaveLength(2);
});

test('it answers the replay of a held spawn key with its session while the grant still reaches it', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const first = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({
        narrow: { targets: ['local'] },
        wide: { targets: ['local', 'box'] },
      }).principals,
    };
  });

  const replayed = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  expect(getRecord(replayed, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(harnesses).toStrictEqual(['box']);
});

test("it refuses a narrow connection a spawn on a wider principal's target, with no session and no replay", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  const client = await daemon.openClient({ principal: 'narrow' });

  const refused = await trySendRequest(
    () =>
      client.sendRequest(
        'session.spawn',
        { cwd: daemon.dir, target: 'box', idempotencyKey: 'k-1' },
        'wide',
      ),
    'k-1',
  );

  expect(refused).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message:
        "this client may not use execution target 'box'. Grant it to the client under principals in config.json and restart the daemon",
      data: { target: 'box' },
    },
  });

  expect(harnesses).toStrictEqual(['box']);
});

test('it runs one spawn for one key on a principal connection, whatever principal each request acts as', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const client = await daemon.openClient({ principal: 'wide' });

  const first = await client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'wide',
  );

  const second = await client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, target: 'local', idempotencyKey: 'k-1' },
    'narrow',
  );

  expect(getRecord(second, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(harnesses).toStrictEqual(['local']);
});

test("it refuses the replay of a forgotten session's spawn key once its target holds another identity", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 3 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
    };
  });

  const replayed = daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  expect(replayed).rejects.toThrowWithMessage(
    DaemonError,
    "this client may not use execution target 'box'. Grant it to the client under principals in config.json and restart the daemon",
  );

  expect(replayed).rejects.toHaveProperty('code', 'target_forbidden');
  expect(replayed).rejects.toHaveProperty('data', { target: 'box' });
  expect(harnesses).toStrictEqual(['box']);
});

test("it answers the replay of a forgotten session's spawn key with its session while its target holds the same identity", async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  await daemon.restart(() => {
    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
    };
  });

  const replayed = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  expect(replayed).toMatchObject({ session: { id, name: 'secret-work' } });
  expect(harnesses).toStrictEqual(['box']);
});

test('it refuses a principal the replay of a held spawn key that records no target', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    idempotencyKey: 'k-owner',
  });

  await daemon.restart(() => {
    const db = new Database(daemon.dbPath);

    const closeDB = registerTestCleanup(() => {
      db.close();
    });

    db.run('UPDATE idempotency SET effect_target = NULL, effect_target_identity = NULL');

    closeDB();

    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
    };
  });

  const replayed = daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  expect(replayed).rejects.toThrowWithMessage(
    DaemonError,
    "this client may not use execution target 'box'. Grant it to the client under principals in config.json and restart the daemon",
  );

  expect(replayed).rejects.toHaveProperty('code', 'target_forbidden');
  expect(replayed).rejects.toHaveProperty('data', { target: 'box' });
  expect(harnesses).toStrictEqual(['box', 'box']);
});

test('it answers the owner the replay of a held spawn key that records no target', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: daemon.dir, name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  const owned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    idempotencyKey: 'k-owner',
  });

  await daemon.restart(() => {
    const db = new Database(daemon.dbPath);

    const closeDB = registerTestCleanup(() => {
      db.close();
    });

    db.run('UPDATE idempotency SET effect_target = NULL, effect_target_identity = NULL');

    closeDB();

    const targets = collectTargets(
      { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      undefined,
    );

    return {
      adapter: buildStubAttentionAdapter(),
      targets: buildStubTargets(targets.targets, { spawned: harnesses }),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals({ p: { targets: ['box'] } }).principals,
    };
  });

  const ownerReplayed = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    idempotencyKey: 'k-owner',
  });

  expect(getRecord(ownerReplayed, 'session')['id']).toBe(getRecord(owned, 'session')['id']);
  expect(harnesses).toStrictEqual(['box', 'box']);
});

test('it lists a principal its sessions in the order it gets when no hidden session sits among them', async () => {
  const harnesses: string[] = [];

  const daemon = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: harnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const cleanHarnesses: string[] = [];

  const clean = await startTestDaemon({
    options: () => {
      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildStubAttentionAdapter(),
        targets: buildStubTargets(targets.targets, { spawned: cleanHarnesses }),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
        principals: collectPrincipals({
          narrow: { targets: ['local'] },
          wide: { targets: ['local', 'box'] },
        }).principals,
      };
    },
  });

  const mixedFirstSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const mixedFirst = String(getRecord(mixedFirstSpawned, 'session')['id']);

  const pinnedHiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const pinnedHidden = String(getRecord(pinnedHiddenSpawned, 'session')['id']);

  const mixedSecondSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const mixedSecond = String(getRecord(mixedSecondSpawned, 'session')['id']);

  const needyHiddenSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: `a-${randomUUID()}`,
  });

  const needyHidden = String(getRecord(needyHiddenSpawned, 'session')['id']);

  const mixedThirdSpawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const mixedThird = String(getRecord(mixedThirdSpawned, 'session')['id']);

  const cleanFirstSpawned = await clean.client.sendRequest('session.spawn', {
    cwd: clean.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const cleanFirst = String(getRecord(cleanFirstSpawned, 'session')['id']);

  const cleanSecondSpawned = await clean.client.sendRequest('session.spawn', {
    cwd: clean.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const cleanSecond = String(getRecord(cleanSecondSpawned, 'session')['id']);

  const cleanThirdSpawned = await clean.client.sendRequest('session.spawn', {
    cwd: clean.dir,
    target: 'local',
    resume: `a-${randomUUID()}`,
  });

  const cleanThird = String(getRecord(cleanThirdSpawned, 'session')['id']);

  await daemon.client.sendRequest('session.update', { session: pinnedHidden, pinned: true });
  await daemon.sendHookLines({ atcId: needyHidden, event: 'Notification', payload: {} });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('session.list');

    expect(owner).toMatchObject({
      sessions: expect.toIncludeAllPartialMembers([
        { id: pinnedHidden, pinned: true },
        { id: needyHidden, state: 'needs_you' },
      ]),
    });
  });

  const mixedLabels = new Map([
    [mixedFirst, 'first'],
    [mixedSecond, 'second'],
    [mixedThird, 'third'],
  ]);

  const cleanLabels = new Map([
    [cleanFirst, 'first'],
    [cleanSecond, 'second'],
    [cleanThird, 'third'],
  ]);

  const mixedListed = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const mixedFleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');
  const cleanListed = await clean.client.sendRequest('session.list', {}, 'narrow');
  const cleanFleet = await clean.client.sendRequest('fleet.list', {}, 'narrow');

  const sessionEntry = z.object({ id: z.string() });
  const fleetEntry = z.object({ sessionID: z.string() });
  const sessionList = z.object({ sessions: z.array(sessionEntry) });
  const fleetList = z.object({ fleet: z.array(fleetEntry) });

  const mixedSessionOrder = sessionList
    .parse(mixedListed)
    .sessions.map((x) => mixedLabels.get(x.id));

  const mixedFleetOrder = fleetList
    .parse(mixedFleet)
    .fleet.map((x) => mixedLabels.get(x.sessionID));

  const cleanSessionOrder = sessionList
    .parse(cleanListed)
    .sessions.map((x) => cleanLabels.get(x.id));

  const cleanFleetOrder = fleetList
    .parse(cleanFleet)
    .fleet.map((x) => cleanLabels.get(x.sessionID));

  expect(cleanSessionOrder).toIncludeSameMembers(['first', 'second', 'third']);
  expect(cleanFleetOrder).toIncludeSameMembers(['first', 'second', 'third']);
  expect(mixedSessionOrder).toStrictEqual(cleanSessionOrder);
  expect(mixedFleetOrder).toStrictEqual(cleanFleetOrder);
});
