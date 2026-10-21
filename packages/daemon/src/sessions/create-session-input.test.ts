import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createScreenModel } from './create-screen-model';
import { createSessionInput } from './create-session-input';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';
import { MENU_TIMING } from './menu-terminal';

interface SetupTestConfig {
  // The one agent the sessions run.
  readonly adapter: AgentAdapter;
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-session-input-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const manager = createSessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [config.adapter],
    [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    [],
    {
      onEvent: (kind, session) => {
        if (kind === 'added') {
          runtimes.set(session.id, createSessionRuntime());
        }
      },
      onBoot: (session, cols, rows) => {
        const runtime = runtimes.get(session.id);

        if (runtime !== undefined) {
          runtime.screen ??= createScreenModel(cols, rows);
        }
      },
      onOutput: (session, data) => {
        runtimes.get(session.id)?.screen?.record(data);
      },
    },
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const startHeadlessTurn = mock<(sessionID: SessionID, prompt: string) => boolean>(() => true);

  const input = createSessionInput({
    manager,
    clock: buildStubClock(1_000_000),
    findRuntime: (id) => runtimes.get(id),
    menuTiming: MENU_TIMING,
    startHeadlessTurn,
  });

  return {
    directory: temporaryDirectory.path,
    provider,
    manager,
    runtimes,
    startHeadlessTurn,
    input,
  };
}

test('it writes raw input to the terminal of the session', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const written = ctx.input.writeSessionInput(session.id, 'y');
  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(written).toBe('ok');
  expect(harness.written).toStrictEqual(['y']);
});

test('it refuses input for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  expect(ctx.input.writeSessionInput(toSessionID('s-gone'), 'y')).toBe('missing');
});

test('it refuses input for a session whose terminal has ended', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(ctx.manager.sessions.find((x) => x.id === session.id)?.pty).toBeNull();
  });

  expect(ctx.input.writeSessionInput(session.id, 'y')).toBe('dead');
});

test('it starts a headless turn with the input as its prompt', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  session.agentSessionID = toAgentSessionID('a-1');

  ctx.manager.yankHeadless(session.id);

  const written = ctx.input.writeSessionInput(session.id, 'run the linter\n');

  expect(written).toBe('ok');
  expect(ctx.startHeadlessTurn).toHaveBeenCalledExactlyOnceWith(session.id, 'run the linter');
});

test('it refuses input for a headless session whose turn still runs', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  session.agentSessionID = toAgentSessionID('a-1');

  ctx.manager.yankHeadless(session.id);

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime);

  runtime.headlessRun = { stop: () => {} };

  const written = ctx.input.writeSessionInput(session.id, 'run the linter');

  expect(written).toBe('busy');
  expect(ctx.startHeadlessTurn).not.toHaveBeenCalled();
});

test('it refuses input for a headless session whose turn cannot start', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  session.agentSessionID = toAgentSessionID('a-1');

  ctx.manager.yankHeadless(session.id);
  ctx.startHeadlessTurn.mockReturnValue(false);

  expect(ctx.input.writeSessionInput(session.id, 'run the linter')).toBe('dead');
});

test('it types a line and its submit key into the terminal', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);
  const written = await ctx.input.writeSessionLine(session.id, 'fix the build');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(written).toBe('ok');
  expect(harness.written).toStrictEqual(['fix the build\n']);
});

test('it types a line as the agent plans it', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), planLineInput: (text) => [text, '\r'] },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.input.writeSessionLine(session.id, 'fix the build');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(harness.written).toStrictEqual(['fix the build', '\r']);
});

test('it refuses a line while a permission prompt is pending', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  session.permissionPending = true;

  const written = await ctx.input.writeSessionLine(session.id, 'fix the build');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(written).toBe('permission_pending');
  expect(harness.written).toBeEmpty();
});

test('it refuses a line for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const written = await ctx.input.writeSessionLine(toSessionID('s-gone'), 'fix the build');

  expect(written).toBe('missing');
});

test('it reads the screen of the session as text', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('all checks green');

  const screen = await ctx.input.readSessionScreen(session.id);

  invariant(typeof screen === 'object');

  expect(screen.text).toInclude('all checks green');
  expect(screen.cols).toBe(80);
});

test('it reads no screen for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const screen = await ctx.input.readSessionScreen(toSessionID('s-gone'));

  expect(screen).toBe('missing');
});

test('it reads the menu the screen of the session shows', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      findMenu: (text) =>
        text.includes('Apply the patch?')
          ? {
              text: 'Apply the patch?',
              options: [
                { label: 'Yes', checked: null },
                { label: 'No', checked: null },
              ],
              highlighted: 0,
            }
          : null,
    },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('Apply the patch?');

  const menu = await ctx.input.readSessionMenu(session.id);

  expect(menu).toMatchObject({
    text: 'Apply the patch?',
    options: [
      { option: 1, label: 'Yes', checked: null, highlighted: true },
      { option: 2, label: 'No', checked: null, highlighted: false },
    ],
  });
});

test('it reads no menu when the screen shows none', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), findMenu: () => null },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);
  const menu = await ctx.input.readSessionMenu(session.id);

  expect(menu).toBeNull();
});

test('it refuses a menu read for an agent that finds no menus', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);
  const menu = await ctx.input.readSessionMenu(session.id);

  expect(menu).toBe('unsupported');
});

test('it refuses a menu read for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const menu = await ctx.input.readSessionMenu(toSessionID('s-gone'));

  expect(menu).toBe('missing');
});

test('it refuses a menu choice whose token matches no menu on the screen', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), findMenu: () => null },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const chosen = ctx.input.applySessionMenuChoice(session.id, {
    menuToken: 'm-stale',
    option: 1,
    label: 'Yes',
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(chosen).rejects.toMatchObject({ code: 'menu_changed' });
  expect(harness.written).toBeEmpty();
});

test('it refuses a menu choice for an agent that finds no menus', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const chosen = await ctx.input.applySessionMenuChoice(session.id, {
    menuToken: 'm-stale',
    key: 'escape',
  });

  expect(chosen).toBe('unsupported');
});

test('it refuses a menu choice for a session whose terminal has ended', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), findMenu: () => null },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(ctx.manager.sessions.find((x) => x.id === session.id)?.pty).toBeNull();
  });

  const chosen = await ctx.input.applySessionMenuChoice(session.id, {
    menuToken: 'm-stale',
    key: 'escape',
  });

  expect(chosen).toBe('dead');
});
