import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import { KEYS } from './keys';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A temp directory for the spec and the log, and a start that runs the
// stand-in on a spec in a terminal of its own, gathering what it prints.
function setupTest() {
  const tmp = setupTempDir('atc-stub-menu-claude-');
  const specPath = join(tmp.dir, 'menu.json');
  const logPath = join(tmp.dir, 'menu.log');

  const startMenu = async (spec: unknown) => {
    writeFileSync(specPath, JSON.stringify(spec));

    const pty = spawn(
      process.execPath,
      [join(import.meta.dir, 'run-stub-menu-claude.ts'), specPath, logPath, '--settings', 'x'],
      { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmp.dir },
    );

    registerTestCleanup(() => {
      pty.kill();
    });

    const output = { text: '' };

    pty.onData((data) => {
      output.text += data;
    });

    await waitFor(() => {
      expect(output.text).toInclude('Enter to confirm');
    });

    return { pty, output };
  };

  const readLog = (): unknown[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line): unknown => JSON.parse(line))
      : [];

  return { dir: tmp.dir, startMenu, readLog };
}

test('it draws a numbered menu with the cursor on the first option', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'numbered', text: ['Do you want to proceed?'], options: ['Yes', 'No'] }],
  });

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    ' Do you want to proceed?\n\n ❯ 1. Yes\n   2. No\n',
  );
});

test('it picks the option the arrow keys move the cursor to', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal', 'Plum'] }],
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Teal');
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([{ key: 'down' }, { key: 'enter' }, { picked: 'Teal' }]);
  });
});

test('it ticks a box on Enter and enables the ticked ones on the submit item', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
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

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ [ ] kettle-notes');
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ [✔] quarry-files');
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯     Enable selected');
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([
      { key: 'enter' },
      { toggled: 'kettle-notes', checked: false },
      { key: 'down' },
      { key: 'down' },
      { key: 'enter' },
      { enabled: ['quarry-files'] },
    ]);
  });
});

test('it dismisses the menu on Escape', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
  });

  menu.pty.write(KEYS.esc);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([{ key: 'escape' }, { dismissed: true }]);
  });
});

test('it refuses Enter during the hold and puts the cursor back when the hold ends', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 1000,
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Yes');
  });

  menu.pty.write(KEYS.enter);

  menu.output.text = '';

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ No, exit');
  });

  expect(ctx.readLog()).toStrictEqual([{ key: 'down' }, { key: 'enter' }]);
});

test('it takes Enter once the hold has ended', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 300,
  });

  await waitFor(() => {
    expect(menu.output.text.match(/❯ No, exit/g)).toHaveLength(2);
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([{ key: 'enter' }, { picked: 'No, exit' }]);
  });
});

test('it shows the second menu once the switch file appears', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
      { kind: 'plain', text: ['Pick a shape'], options: ['Circle', 'Square'] },
    ],
    switchFile: join(ctx.dir, 'switch'),
  });

  writeFileSync(join(ctx.dir, 'switch'), '');

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Circle');
  });
});
