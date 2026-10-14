import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config/config';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import { buildStubMenuClaude } from '@atc/test-utils/build-stub-menu-claude';
import { getRecord } from '@atc/test-utils/get-record';
import { waitFor } from '@atc/test-utils/wait-for';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { startTestDaemon } from '../test-utils/start-test-daemon';

// A daemon whose `claude` agent is the real Claude adapter running the
// stand-in menu `claude` on `menu.json` in the daemon's directory, logging
// to `menu.log` there, beside a `grok` agent that reads no menus, and a
// spawn that waits for the session's menu.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-menu-choice-',
    options: (paths) => {
      const claude = buildStubMenuClaude(join(paths.dir, 'menu.json'), join(paths.dir, 'menu.log'));

      const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
        agents: { claude, grok: { bin: 'bash', args: ['-c', 'sleep 30'] } },
      });

      // A quiet wait longer than the stand-in's hold, and short enough to keep
      // each choice under two seconds.
      const menuTiming = {
        pollMs: 20,
        quietMs: 1000,
        quietCapMs: 5000,
        moveMs: 1500,
        settleMs: 2000,
        stableMs: 200,
      };

      return { adapters: buildAgentAdapters(config, buildMockHostServices()), menuTiming };
    },
  });

  const spawnMenu = async (spec: unknown) => {
    writeFileSync(join(daemon.dir, 'menu.json'), JSON.stringify(spec));

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
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

  const readLog = (): unknown[] =>
    existsSync(join(daemon.dir, 'menu.log'))
      ? readFileSync(join(daemon.dir, 'menu.log'), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line): unknown => JSON.parse(line))
      : [];

  return { daemon, spawnMenu, readLog };
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
    menuToken: expect.stringMatching(/^[0-9a-f]{16}$/),
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

  expect(ctx.readLog()).toStrictEqual([
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

  expect(ctx.readLog()).toStrictEqual([
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
    enterDelayMs: 600,
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

  expect(ctx.readLog()).toStrictEqual([
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

  expect(ctx.readLog()).toStrictEqual([
    { key: 'down' },
    { key: 'down' },
    { key: 'enter' },
    { enabled: ['kettle-notes'] },
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
  expect(ctx.readLog()).toStrictEqual([]);
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
  expect(ctx.readLog()).toStrictEqual([]);
});

test('it refuses a choice on a menu that changed since the read and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'numbered', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] },
      { kind: 'numbered', text: ['Allow external imports?'], options: ['No, exit', 'Yes'] },
    ],
    switchFile: join(ctx.daemon.dir, 'switch'),
  });

  writeFileSync(join(ctx.daemon.dir, 'switch'), '');

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
  expect(ctx.readLog()).toStrictEqual([]);
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
  expect(ctx.readLog()).toStrictEqual([{ key: 'escape' }, { dismissed: true }]);
});

test('it refuses Escape on a menu that changed since the read and sends nothing', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
      { kind: 'plain', text: ['Pick a shape'], options: ['Circle', 'Square'] },
    ],
    switchFile: join(ctx.daemon.dir, 'switch'),
  });

  writeFileSync(join(ctx.daemon.dir, 'switch'), '');

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
  expect(ctx.readLog()).toStrictEqual([]);
});

test('it waits out the hold of a menu that has just opened before it picks', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 600,
  });

  const chosen = await ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 2,
    label: 'Yes',
  });

  expect(chosen).toStrictEqual({ pressed: 'enter', menu: null });
  expect(ctx.readLog()).toStrictEqual([{ key: 'down' }, { key: 'enter' }, { picked: 'Yes' }]);
});

test('it refuses a choice of the option under the cursor once the session exits during the quiet wait', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    exitFile: join(ctx.daemon.dir, 'exit'),
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    option: 1,
    label: 'No, exit',
  });

  writeFileSync(join(ctx.daemon.dir, 'exit'), '');

  expect(chosen).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.readLog()).toStrictEqual([]);
});

test('it refuses Escape once the session exits during the quiet wait', async () => {
  const ctx = await setupTest();

  const shown = await ctx.spawnMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    exitFile: join(ctx.daemon.dir, 'exit'),
  });

  const chosen = ctx.daemon.client.sendRequest('session.choose', {
    session: shown.session,
    menuToken: shown.menu['menuToken'],
    key: 'escape',
  });

  writeFileSync(join(ctx.daemon.dir, 'exit'), '');

  expect(chosen).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.readLog()).toStrictEqual([]);
});

test('it refuses a menu read for an agent whose adapter reads no menus', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const session = String(getRecord(spawned, 'session')['id']);

  expect(ctx.daemon.client.sendRequest('session.menu', { session })).rejects.toMatchObject({
    code: 'unsupported',
  });
});
