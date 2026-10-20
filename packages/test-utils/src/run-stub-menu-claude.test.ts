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
  const temporaryDirectory = setupTempDir('atc-stub-menu-claude-');
  const specPath = join(temporaryDirectory.path, 'menu.json');
  const logPath = join(temporaryDirectory.path, 'menu.log');

  const startMenu = async (spec: unknown) => {
    writeFileSync(specPath, JSON.stringify(spec));

    const pty = spawn(
      process.execPath,
      [join(import.meta.dir, 'run-stub-menu-claude.ts'), specPath, logPath, '--settings', 'x'],
      { name: 'xterm-256color', cols: 80, rows: 24, cwd: temporaryDirectory.path },
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

  return { directory: temporaryDirectory.path, startMenu, readLog };
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

test('it draws a window of a long list with a mark beside its last row', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['4 new MCP servers found in this project'],
        options: ['kettle-notes', 'orchard-search', 'quarry-files', 'lantern-docs'],
        checked: [true, true, true, true],
        submit: 'Enable selected',
        window: 2,
      },
    ],
  });

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    '\n ❯ [✔] kettle-notes\n ↓ [✔] orchard-search\n       Enable selected\n',
  );
});

test('it scrolls the window one row once the cursor moves past its last row', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['4 new MCP servers found in this project'],
        options: ['kettle-notes', 'orchard-search', 'quarry-files', 'lantern-docs'],
        checked: [true, true, true, true],
        submit: 'Enable selected',
        window: 2,
      },
    ],
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ [✔] orchard-search');
  });

  menu.output.text = '';

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text.replaceAll('\r', '')).toInclude(
      '\n ↑ [✔] orchard-search\n ❯ [✔] quarry-files\n       Enable selected\n',
    );
  });
});

test('it moves the cursor from the last option of a long box list to the submit item', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      {
        kind: 'boxes',
        text: ['3 new MCP servers found in this project'],
        options: ['kettle-notes', 'orchard-search', 'quarry-files'],
        checked: [true, true, true],
        submit: 'Enable selected',
        cursor: 2,
        window: 2,
      },
    ],
  });

  menu.output.text = '';

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text.replaceAll('\r', '')).toInclude(
      '\n ↑ [✔] orchard-search\n   [✔] quarry-files\n ❯     Enable selected\n',
    );
  });
});

test('it wraps the cursor of a long plain list from its last option to its first', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      {
        kind: 'plain',
        text: ['Pick a colour'],
        options: ['Amber', 'Teal', 'Plum'],
        cursor: 2,
        window: 2,
      },
    ],
  });

  menu.output.text = '';

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text.replaceAll('\r', '')).toInclude('\n ❯ Amber\n ↓ Teal\n');
  });
});

test('it wraps the cursor of a long plain list from its first option to its last', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal', 'Plum'], window: 2 },
    ],
  });

  menu.output.text = '';

  menu.pty.write(KEYS.up);

  await waitFor(() => {
    expect(menu.output.text.replaceAll('\r', '')).toInclude('\n ↑ Teal\n ❯ Plum\n');
  });
});

test('it opens the second menu in place of the outcome when a pick opens the next', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      { kind: 'plain', text: ['Trust this folder?'], options: ['Yes', 'No'] },
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
    ],
    pickOpensNext: true,
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Amber');
  });

  menu.pty.write(KEYS.down);

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Teal');
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([
      { key: 'enter' },
      { picked: 'Yes' },
      { key: 'down' },
      { key: 'enter' },
      { picked: 'Teal' },
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
    expect(menu.output.text.match(/❯ No, exit/gu)).toHaveLength(2);
  });

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([{ key: 'enter' }, { picked: 'No, exit' }]);
  });
});

test('it answers Enter only once the Enter delay has passed', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
    enterDelayMs: 300,
  });

  const sentAt = Date.now();

  menu.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.readLog()).toStrictEqual([{ key: 'enter' }, { picked: 'Amber' }]);
  });

  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(300);
});

test('it shows the second menu once the switch file appears', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
      { kind: 'plain', text: ['Pick a shape'], options: ['Circle', 'Square'] },
    ],
    switchFile: join(ctx.directory, 'switch'),
  });

  writeFileSync(join(ctx.directory, 'switch'), '');

  await waitFor(() => {
    expect(menu.output.text).toInclude('❯ Circle');
  });
});

test('it exits without printing once the exit file appears', async () => {
  const ctx = setupTest();

  const menu = await ctx.startMenu({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
    exitFile: join(ctx.directory, 'exit'),
  });

  const exited = new Promise<number>((resolve) => {
    menu.pty.onExit((event) => {
      resolve(event.exitCode);
    });
  });

  menu.output.text = '';

  writeFileSync(join(ctx.directory, 'exit'), '');

  const exitCode = await exited;

  expect(exitCode).toBe(0);
  expect(menu.output.text).toBe('');
});
