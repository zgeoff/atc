import { expect, test } from 'bun:test';
import { LOCAL_TARGET, parseConfig } from '@atc/config';
import {
  buildMockExecutionTarget,
  buildStubMemoryProvider,
  buildStubMenuClaude,
} from '@atc/daemon/testing';
import { buildTargetIdentity } from '@atc/store';
import { buildMockHostServices, getRecord, waitFor } from '@atc/test-utils';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  const claude = buildStubMenuClaude();

  const daemon = await startTestDaemon({
    prefix: 'atc-menu-choice-',
    options: () => {
      // The provider runs no binary, but the adapters refuse an agent whose
      // binary the host lacks, so each names one every host has.
      const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
        agents: { claude: { bin: process.execPath }, grok: { bin: process.execPath } },
      });

      // The stand-in draws in the daemon's own process, so no other process's
      // scheduling stretches its output. The quiet wait outlasts the scenarios'
      // hold and enter delay.
      const menuTiming = {
        pollMs: 5,
        quietMs: 250,
        quietCapMs: 1250,
        moveMs: 375,
        settleMs: 500,
        stableMs: 50,
      };

      return {
        adapters: buildAgentAdapters(config, buildMockHostServices()),
        targets: [
          buildMockExecutionTarget({
            id: LOCAL_TARGET.id,
            kind: LOCAL_TARGET.provider,
            identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
            provider: buildStubMemoryProvider({ kind: 'local-pty', onStart: claude.start }),
          }),
        ],
        menuTiming,
      };
    },
  });

  const spawnMenu = async (scenario: Parameters<typeof claude.load>[0]) => {
    claude.load(scenario);

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      agent: 'claude',
      cols: 80,
      rows: 24,
    });

    const session = String(getRecord(spawned, 'session')['id']);

    // The stand-in draws its footer last, so a screen that shows it holds the
    // whole menu and never a half-drawn one.
    await waitFor(async () => {
      const screen = await daemon.client.sendRequest('session.screen', { session });

      expect(screen['text']).toInclude('Enter to confirm');
    });

    const read = await daemon.client.sendRequest('session.menu', { session });

    return { session, menu: getRecord(read, 'menu') };
  };

  return { daemon, claude, spawnMenu };
}

test('it reads the text and options of the menu a session waits on', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'numbered',
        text: ['Bash command', '', '  rm -rf build', '', 'Do you want to proceed?'],
        options: ['Yes', "Yes, and don't ask again for rm commands", 'No'],
      },
    ],
  });

  expect(shown.menu).toStrictEqual({
    text: 'Bash command\n\n  rm -rf build\n\nDo you want to proceed?',
    options: [
      { option: 1, label: 'Yes', checked: null, highlighted: true },
      {
        option: 2,
        label: "Yes, and don't ask again for rm commands",
        checked: null,
        highlighted: false,
      },
      { option: 3, label: 'No', checked: null, highlighted: false },
    ],
    menuToken: expect.stringMatching(/^[0-9a-f]{16}$/u),
  });
});

test('it reads the boxes and the enable item of the new MCP servers menu', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['2 new MCP servers found in this project', '', 'Select any you wish to enable.'],
        options: ['kettle-notes', 'quarry-files'],
        checked: [true, false],
        submit: 'Enable selected',
      },
    ],
  });

  expect(shown.menu['options']).toStrictEqual([
    { option: 1, label: 'kettle-notes', checked: true, highlighted: true },
    { option: 2, label: 'quarry-files', checked: false, highlighted: false },
    { option: 3, label: 'Enable selected', checked: null, highlighted: false },
  ]);
});

test('it picks the option a choice gives with its expected label', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'numbered',
        text: ['Do you want to proceed?'],
        options: ['Yes', 'Yes, and keep allowing reads', 'No', 'Not now'],
      },
    ],
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 3,
    label: 'No',
  });

  expect(chosen).toStrictEqual({ pressed: 'enter', menu: null });

  expect(ctx.claude.log).toStrictEqual([
    { key: 'down' },
    { key: 'down' },
    { key: 'enter' },
    { picked: 'No' },
  ]);
});

test('it moves the cursor up to an option above it', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal', 'Plum'], cursor: 2 },
    ],
  });

  await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'Amber',
  });

  expect(ctx.claude.log).toStrictEqual([
    { key: 'up' },
    { key: 'up' },
    { key: 'enter' },
    { picked: 'Amber' },
  ]);
});

test('it ticks a box and returns the menu with its new token', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['2 new MCP servers found in this project'],
        options: ['kettle-notes', 'quarry-files'],
        checked: [true, true],
        submit: 'Enable selected',
      },
    ],
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'quarry-files',
  });

  expect(chosen).toStrictEqual({
    pressed: 'enter',
    menu: {
      text: '2 new MCP servers found in this project',
      options: [
        { option: 1, label: 'kettle-notes', checked: true, highlighted: false },
        { option: 2, label: 'quarry-files', checked: false, highlighted: true },
        { option: 3, label: 'Enable selected', checked: null, highlighted: false },
      ],
      menuToken: expect.toBeString(),
    },
  });

  expect(getRecord(chosen, 'menu')['menuToken']).not.toBe(shown.menu['menuToken']);
});

test('it returns the menu as Enter leaves it when Enter lands well after the cursor moves', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['2 new MCP servers found in this project'],
        options: ['kettle-notes', 'quarry-files'],
        checked: [true, false],
        submit: 'Enable selected',
      },
    ],
    enterDelayMs: 150,
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'quarry-files',
  });

  expect(chosen).toStrictEqual({
    pressed: 'enter',
    menu: {
      text: '2 new MCP servers found in this project',
      options: [
        { option: 1, label: 'kettle-notes', checked: true, highlighted: false },
        { option: 2, label: 'quarry-files', checked: true, highlighted: true },
        { option: 3, label: 'Enable selected', checked: null, highlighted: false },
      ],
      menuToken: expect.toBeString(),
    },
  });

  expect(ctx.claude.log).toStrictEqual([
    { key: 'down' },
    { key: 'enter' },
    { toggled: 'quarry-files', checked: true },
  ]);
});

test('it confirms the boxes ticked when a choice picks the enable item', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['2 new MCP servers found in this project'],
        options: ['kettle-notes', 'quarry-files'],
        checked: [true, false],
        submit: 'Enable selected',
      },
    ],
  });

  await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 3,
    label: 'Enable selected',
  });

  expect(ctx.claude.log).toStrictEqual([
    { key: 'down' },
    { key: 'down' },
    { key: 'enter' },
    { enabled: ['kettle-notes'] },
  ]);
});

test('it reads every option of a list longer than the screen shows, and puts the cursor back', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['8 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
          'harbor-queue',
          'ember-metrics',
        ],
        checked: [true, true, true, true, true, true, true, true],
        submit: 'Enable selected',
        window: 5,
      },
    ],
  });

  expect(shown.menu['options']).toStrictEqual([
    { option: 1, label: 'kettle-notes', checked: true, highlighted: true },
    { option: 2, label: 'orchard-search', checked: true, highlighted: false },
    { option: 3, label: 'quarry-files', checked: true, highlighted: false },
    { option: 4, label: 'lantern-docs', checked: true, highlighted: false },
    { option: 5, label: 'meadow-index', checked: true, highlighted: false },
    { option: 6, label: 'willow-cache', checked: true, highlighted: false },
    { option: 7, label: 'harbor-queue', checked: true, highlighted: false },
    { option: 8, label: 'ember-metrics', checked: true, highlighted: false },
    { option: 9, label: 'Enable selected', checked: null, highlighted: false },
  ]);

  expect(ctx.claude.log).not.toBeEmpty();

  expect(ctx.claude.log).toSatisfyAll(
    (entry: unknown) =>
      JSON.stringify(entry) === '{"key":"up"}' || JSON.stringify(entry) === '{"key":"down"}',
  );
});

test('it reads every option of a long list whose cursor hides the mark of options below', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['7 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
          'harbor-queue',
        ],
        checked: [true, true, true, true, true, true, true],
        submit: 'Enable selected',
        cursor: 4,
        window: 5,
      },
    ],
  });

  expect(shown.menu['options']).toStrictEqual([
    { option: 1, label: 'kettle-notes', checked: true, highlighted: false },
    { option: 2, label: 'orchard-search', checked: true, highlighted: false },
    { option: 3, label: 'quarry-files', checked: true, highlighted: false },
    { option: 4, label: 'lantern-docs', checked: true, highlighted: false },
    { option: 5, label: 'meadow-index', checked: true, highlighted: true },
    { option: 6, label: 'willow-cache', checked: true, highlighted: false },
    { option: 7, label: 'harbor-queue', checked: true, highlighted: false },
    { option: 8, label: 'Enable selected', checked: null, highlighted: false },
  ]);
});

test('it refuses to read a list whose window shows one row at a time', async () => {
  const ctx = await setupTest();

  const shown = await ctx
    .spawnMenu({
      menus: [
        {
          kind: 'boxes',
          text: ['3 new MCP servers found in this project'],
          options: ['kettle-notes', 'orchard-search', 'quarry-files'],
          checked: [true, true, true],
          submit: 'Enable selected',
          cursor: 3,
          window: 1,
        },
      ],
    })
    .catch((error: unknown) => error);

  expect(shown).toMatchObject({ code: 'menu_busy' });
});

test('it reads a long list it has read whole before without pressing a key', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['6 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
        ],
        checked: [true, true, true, true, true, true],
        submit: 'Enable selected',
        window: 5,
      },
    ],
  });

  const keys = ctx.claude.log.length;

  const read = await ctx.daemon.client.sendRequest('session.menu', { session: shown.session });

  expect(getRecord(read, 'menu')).toStrictEqual(shown.menu);
  expect(ctx.claude.log).toHaveLength(keys);
});

test('it picks the last option of a list longer than the screen by its number and label', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['8 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
          'harbor-queue',
          'ember-metrics',
        ],
        checked: [true, false, true, true, false, true, true, true],
        submit: 'Enable selected',
        window: 5,
      },
    ],
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 9,
    label: 'Enable selected',
  });

  expect(chosen).toStrictEqual({ pressed: 'enter', menu: null });

  expect(ctx.claude.log.slice(-2)).toStrictEqual([
    { key: 'enter' },
    {
      enabled: [
        'kettle-notes',
        'quarry-files',
        'lantern-docs',
        'willow-cache',
        'harbor-queue',
        'ember-metrics',
      ],
    },
  ]);
});

test('it ticks a box below the screen and returns the whole list with its new token', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['7 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
          'harbor-queue',
        ],
        checked: [true, true, true, true, true, true, true],
        submit: 'Enable selected',
        window: 5,
      },
    ],
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 7,
    label: 'harbor-queue',
  });

  expect(chosen).toStrictEqual({
    pressed: 'enter',
    menu: {
      text: '7 new MCP servers found in this project',
      options: [
        { option: 1, label: 'kettle-notes', checked: true, highlighted: false },
        { option: 2, label: 'orchard-search', checked: true, highlighted: false },
        { option: 3, label: 'quarry-files', checked: true, highlighted: false },
        { option: 4, label: 'lantern-docs', checked: true, highlighted: false },
        { option: 5, label: 'meadow-index', checked: true, highlighted: false },
        { option: 6, label: 'willow-cache', checked: true, highlighted: false },
        { option: 7, label: 'harbor-queue', checked: false, highlighted: true },
        { option: 8, label: 'Enable selected', checked: null, highlighted: false },
      ],
      menuToken: expect.toBeString(),
    },
  });

  expect(getRecord(chosen, 'menu')['menuToken']).not.toBe(shown.menu['menuToken']);
});

test('it returns the whole of a long menu a choice opens, with a token the next choice takes', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'numbered', text: ['Do you trust this folder?'], options: ['Yes', 'No'] },
      {
        kind: 'boxes',
        text: ['6 new MCP servers found in this project'],
        options: [
          'kettle-notes',
          'orchard-search',
          'quarry-files',
          'lantern-docs',
          'meadow-index',
          'willow-cache',
        ],
        checked: [true, true, true, true, true, false],
        submit: 'Enable selected',
        window: 3,
      },
    ],
    pickOpensNext: true,
  });

  const opened = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'Yes',
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: getRecord(opened, 'menu')['menuToken'],
    option: 7,
    label: 'Enable selected',
  });

  expect(chosen).toStrictEqual({ pressed: 'enter', menu: null });

  expect(ctx.claude.log.at(-1)).toStrictEqual({
    enabled: ['kettle-notes', 'orchard-search', 'quarry-files', 'lantern-docs', 'meadow-index'],
  });
});

test('it returns the menu the screen shows, marked partial, when the read of the menu a choice opens fails after moving the cursor', async () => {
  const ctx = await setupTest();

  // Six rows with one label scroll the window without a change atc can see,
  // so the read's down arrow from the fifth row seems ignored.
  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'numbered', text: ['Do you trust this folder?'], options: ['Yes', 'No'] },
      {
        kind: 'plain',
        text: ['Pick a mirror for the parcel index'],
        options: [
          'harbor-mirror',
          'harbor-mirror',
          'harbor-mirror',
          'harbor-mirror',
          'harbor-mirror',
          'harbor-mirror',
        ],
        window: 5,
      },
    ],
    pickOpensNext: true,
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'Yes',
  });

  const screen = await ctx.daemon.client.sendRequest('session.screen', {
    session: shown.session,
  });

  expect(chosen).toStrictEqual({
    pressed: 'enter',
    partial: true,
    menu: {
      text: 'Pick a mirror for the parcel index',
      options: [
        { option: 1, label: 'harbor-mirror', checked: null, highlighted: false },
        { option: 2, label: 'harbor-mirror', checked: null, highlighted: false },
        { option: 3, label: 'harbor-mirror', checked: null, highlighted: false },
        { option: 4, label: 'harbor-mirror', checked: null, highlighted: false },
        { option: 5, label: 'harbor-mirror', checked: null, highlighted: true },
      ],
      menuToken: expect.toBeString(),
    },
  });

  expect(String(screen['text']).split('\n').slice(3, 8)).toStrictEqual([
    ' ↑ harbor-mirror',
    '   harbor-mirror',
    '   harbor-mirror',
    '   harbor-mirror',
    ' ❯ harbor-mirror',
  ]);
});

test('it reads afresh a long list that Enter opens with the same text and rows in view', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Coral', 'Slate'],
        window: 3,
      },
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Ochre', 'Sage', 'Indigo'],
        window: 3,
      },
    ],
    pickOpensNext: true,
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'Amber',
  });

  expect(getRecord(chosen, 'menu')['options']).toStrictEqual([
    { option: 1, label: 'Amber', checked: null, highlighted: true },
    { option: 2, label: 'Teal', checked: null, highlighted: false },
    { option: 3, label: 'Plum', checked: null, highlighted: false },
    { option: 4, label: 'Ochre', checked: null, highlighted: false },
    { option: 5, label: 'Sage', checked: null, highlighted: false },
    { option: 6, label: 'Indigo', checked: null, highlighted: false },
  ]);
});

test('it reads afresh a long list after input from outside a menu read or choice', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Coral', 'Slate'],
        window: 3,
      },
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Ochre', 'Sage', 'Indigo'],
        window: 3,
      },
    ],
  });

  await ctx.daemon.client.sendRequest('session.input', { session: shown.session, data: 'x' });

  await waitFor(() => {
    expect(ctx.claude.log.at(-1)).toStrictEqual({ key: 'x' });
  });

  await ctx.claude.switchMenu();

  const read = await ctx.daemon.client.sendRequest('session.menu', { session: shown.session });

  expect(getRecord(read, 'menu')['options']).toStrictEqual([
    { option: 1, label: 'Amber', checked: null, highlighted: true },
    { option: 2, label: 'Teal', checked: null, highlighted: false },
    { option: 3, label: 'Plum', checked: null, highlighted: false },
    { option: 4, label: 'Ochre', checked: null, highlighted: false },
    { option: 5, label: 'Sage', checked: null, highlighted: false },
    { option: 6, label: 'Indigo', checked: null, highlighted: false },
  ]);
});

test('it reads afresh a long menu that opens again with the same text after closing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Coral', 'Slate'],
        window: 3,
      },
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum', 'Ochre', 'Sage', 'Indigo'],
        window: 3,
      },
    ],
  });

  await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'Amber',
  });

  await ctx.claude.switchMenu();

  await waitFor(async () => {
    const screen = await ctx.daemon.client.sendRequest('session.screen', {
      session: shown.session,
    });

    expect(screen['text']).toInclude('Enter to confirm');
  });

  const read = await ctx.daemon.client.sendRequest('session.menu', { session: shown.session });

  expect(getRecord(read, 'menu')['options']).toStrictEqual([
    { option: 1, label: 'Amber', checked: null, highlighted: true },
    { option: 2, label: 'Teal', checked: null, highlighted: false },
    { option: 3, label: 'Plum', checked: null, highlighted: false },
    { option: 4, label: 'Ochre', checked: null, highlighted: false },
    { option: 5, label: 'Sage', checked: null, highlighted: false },
    { option: 6, label: 'Indigo', checked: null, highlighted: false },
  ]);
});

test('it refuses a label that differs from the option and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'numbered', text: ['Do you want to proceed?'], options: ['Yes', 'No'] }],
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'Yes',
  });

  expect(chosen).rejects.toMatchObject({ code: 'menu_label_mismatch' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it refuses an option the menu does not have and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'numbered', text: ['Do you want to proceed?'], options: ['Yes', 'No'] }],
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 5,
    label: 'No',
  });

  expect(chosen).rejects.toMatchObject({ code: 'menu_label_mismatch' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it refuses a choice on a menu that changed since the read and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'numbered', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] },
      { kind: 'numbered', text: ['Allow external imports?'], options: ['No, exit', 'Yes'] },
    ],
  });

  await ctx.claude.switchMenu();

  await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('session.menu', { session: shown.session });

    expect(getRecord(answer, 'menu')['text']).toBe('Allow external imports?');
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'Yes',
  });

  expect(chosen).rejects.toMatchObject({ code: 'menu_changed' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it dismisses the menu on Escape', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['2 new MCP servers found in this project'],
        options: ['kettle-notes', 'quarry-files'],
        checked: [true, true],
        submit: 'Enable selected',
      },
    ],
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    key: 'escape',
  });

  expect(chosen).toStrictEqual({ pressed: 'escape', menu: null });
  expect(ctx.claude.log).toStrictEqual([{ key: 'escape' }, { dismissed: true }]);
});

test('it refuses Escape on a menu that changed since the read and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
      { kind: 'plain', text: ['Pick a shape'], options: ['Circle', 'Square'] },
    ],
  });

  await ctx.claude.switchMenu();

  await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('session.menu', { session: shown.session });

    expect(getRecord(answer, 'menu')['text']).toBe('Pick a shape');
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    key: 'escape',
  });

  expect(chosen).rejects.toMatchObject({ code: 'menu_changed' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it waits out the hold of a menu that has just opened before it picks', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 150,
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'Yes',
  });

  expect(chosen).toStrictEqual({ pressed: 'enter', menu: null });
  expect(ctx.claude.log).toStrictEqual([{ key: 'down' }, { key: 'enter' }, { picked: 'Yes' }]);
});

test('it refuses a choice of the option under the cursor once the session exits during the quiet wait', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'No, exit',
  });

  // The daemon starts each request in the order it reads them, so the choice
  // is in its quiet wait once a later request has its answer.
  await ctx.daemon.client.sendRequest('session.get', { session: shown.session });

  ctx.claude.exit();

  expect(chosen).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it refuses Escape once the session exits during the quiet wait', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    key: 'escape',
  });

  // The daemon starts each request in the order it reads them, so the choice
  // is in its quiet wait once a later request has its answer.
  await ctx.daemon.client.sendRequest('session.get', { session: shown.session });

  ctx.claude.exit();

  expect(chosen).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.claude.log).toStrictEqual([]);
});

test('it refuses a menu read for an agent whose adapter reads no menus', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const session = String(getRecord(spawned, 'session')['id']);

  expect(ctx.daemon.client.sendRequest('session.menu', { session })).rejects.toMatchObject({
    code: 'unsupported',
  });
});
