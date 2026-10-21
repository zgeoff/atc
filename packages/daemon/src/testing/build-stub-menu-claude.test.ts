import { expect, test } from 'bun:test';
import { KEYS, buildStubClock } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildStubMemoryProvider } from './build-stub-memory-provider';
import { buildStubMenuClaude } from './build-stub-menu-claude';

// The stand-in on a provider of its own and a stub clock, and a start that
// spawns one session on it, gathering what the session draws from before
// the stand-in runs.
function setupTest() {
  const clock = buildStubClock(0);
  const claude = buildStubMenuClaude(clock);

  const outputs = new Map<unknown, { text: string }>();

  const provider = buildStubMemoryProvider({
    onStart: (harness) => {
      const output = { text: '' };

      outputs.set(harness, output);

      harness.onData((data) => {
        output.text += data;
      });

      claude.start(harness);
    },
  });

  const start = () => {
    const harness = provider.spawnHarness({
      session: 's-1',
      host: 's-1',
      bin: 'claude',
      args: [],
      cwd: '/work',
      env: {},
      cols: 80,
      rows: 24,
    });

    const output = outputs.get(harness);

    invariant(output !== undefined, 'the provider started no stand-in');

    return { harness, output };
  };

  return { clock, claude, provider, start };
}

test('it draws a numbered menu with the cursor on the first option', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'numbered', text: ['Do you want to proceed?'], options: ['Yes', 'No'] }],
  });

  const menu = ctx.start();

  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    ' Do you want to proceed?\n\n ❯ 1. Yes\n   2. No\n',
  );
});

test('it draws its menu only after the write that starts it', () => {
  const ctx = setupTest();

  ctx.claude.load({ menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber'] }] });

  const menu = ctx.start();
  const drawnInsideStart = menu.output.text;

  ctx.clock.advance(0);

  expect(drawnInsideStart).toBe('');
  expect(menu.output.text).toInclude('❯ Amber');
});

test('it picks the option the arrow keys move the cursor to', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal', 'Plum'] }],
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  const drawn = menu.output.text;

  menu.harness.write(KEYS.enter);

  expect(drawn).toInclude('❯ Teal');
  expect(ctx.claude.log).toStrictEqual([{ key: 'down' }, { key: 'enter' }, { picked: 'Teal' }]);
});

test('it ticks a box on Enter and enables the ticked ones on the submit item', () => {
  const ctx = setupTest();

  ctx.claude.load({
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

  const menu = ctx.start();

  menu.harness.write(KEYS.enter);
  ctx.clock.advance(0);

  const ticked = menu.output.text;

  menu.harness.write(KEYS.down);
  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  const onSubmit = menu.output.text;

  menu.harness.write(KEYS.enter);

  expect(ticked).toInclude('❯ [ ] kettle-notes');
  expect(onSubmit).toInclude('❯     Enable selected');

  expect(ctx.claude.log).toStrictEqual([
    { key: 'enter' },
    { toggled: 'kettle-notes', checked: false },
    { key: 'down' },
    { key: 'down' },
    { key: 'enter' },
    { enabled: ['quarry-files'] },
  ]);
});

test('it draws a window of a long list with a mark beside its last row', () => {
  const ctx = setupTest();

  ctx.claude.load({
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

  const menu = ctx.start();

  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    '\n ❯ [✔] kettle-notes\n ↓ [✔] orchard-search\n       Enable selected\n',
  );
});

test('it scrolls the window one row once the cursor moves past its last row', () => {
  const ctx = setupTest();

  ctx.claude.load({
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

  const menu = ctx.start();

  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  menu.output.text = '';

  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    '\n ↑ [✔] orchard-search\n ❯ [✔] quarry-files\n       Enable selected\n',
  );
});

test('it moves the cursor from the last option of a long box list to the submit item', () => {
  const ctx = setupTest();

  ctx.claude.load({
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

  const menu = ctx.start();

  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude(
    '\n ↑ [✔] orchard-search\n   [✔] quarry-files\n ❯     Enable selected\n',
  );
});

test('it wraps the cursor of a long plain list from its last option to its first', () => {
  const ctx = setupTest();

  ctx.claude.load({
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

  const menu = ctx.start();

  menu.harness.write(KEYS.down);
  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude('\n ❯ Amber\n ↓ Teal\n');
});

test('it wraps the cursor of a long plain list from its first option to its last', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal', 'Plum'], window: 2 },
    ],
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.up);
  ctx.clock.advance(0);

  expect(menu.output.text.replaceAll('\r', '')).toInclude('\n ↑ Teal\n ❯ Plum\n');
});

test('it opens the second menu in place of the outcome when a pick opens the next', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [
      { kind: 'plain', text: ['Trust this folder?'], options: ['Yes', 'No'] },
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
    ],
    pickOpensNext: true,
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.enter);
  ctx.clock.advance(0);

  const opened = menu.output.text;

  menu.harness.write(KEYS.down);
  menu.harness.write(KEYS.enter);

  expect(opened).toInclude('❯ Amber');

  expect(ctx.claude.log).toStrictEqual([
    { key: 'enter' },
    { picked: 'Yes' },
    { key: 'down' },
    { key: 'enter' },
    { picked: 'Teal' },
  ]);
});

test('it dismisses the menu on Escape', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.esc);

  expect(ctx.claude.log).toStrictEqual([{ key: 'escape' }, { dismissed: true }]);
});

test('it refuses Enter during the hold and puts the cursor back when the hold ends', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 300,
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.down);
  ctx.clock.advance(100);

  const moved = menu.output.text;

  menu.harness.write(KEYS.enter);

  menu.output.text = '';

  ctx.clock.advance(299);

  const beforeHoldEnd = menu.output.text;

  ctx.clock.advance(1);

  expect(moved).toInclude('❯ Yes');
  expect(beforeHoldEnd).toBe('');
  expect(menu.output.text).toInclude('❯ No, exit');
  expect(ctx.claude.log).toStrictEqual([{ key: 'down' }, { key: 'enter' }]);
});

test('it takes Enter once the hold has ended', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Trust this folder?'], options: ['No, exit', 'Yes'] }],
    holdMs: 100,
  });

  const menu = ctx.start();

  ctx.clock.advance(100);

  const drawn = menu.output.text;

  menu.harness.write(KEYS.enter);

  expect(drawn.match(/❯ No, exit/gu)).toHaveLength(2);
  expect(ctx.claude.log).toStrictEqual([{ key: 'enter' }, { picked: 'No, exit' }]);
});

test('it answers Enter only once the Enter delay has passed', () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
    enterDelayMs: 100,
  });

  const menu = ctx.start();

  menu.harness.write(KEYS.enter);
  ctx.clock.advance(99);

  const beforeDelay = [...ctx.claude.log];

  ctx.clock.advance(1);

  expect(beforeDelay).toStrictEqual([{ key: 'enter' }]);
  expect(ctx.claude.log).toStrictEqual([{ key: 'enter' }, { picked: 'Amber' }]);
});

test('it has drawn the second menu by the time a switch resolves', async () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [
      { kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] },
      { kind: 'plain', text: ['Pick a shape'], options: ['Circle', 'Square'] },
    ],
  });

  const menu = ctx.start();
  const switched = ctx.claude.switchMenu();

  ctx.clock.advance(0);

  await switched;

  expect(menu.output.text).toInclude('❯ Circle');
});

test('it exits with code 0 and draws nothing more when the test ends it', async () => {
  const ctx = setupTest();

  ctx.claude.load({
    menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber', 'Teal'] }],
  });

  const menu = ctx.start();

  ctx.claude.exit();
  ctx.clock.advance(0);

  const exited = await menu.harness.waitForExit(1000);

  expect(exited).toBeTrue();
  expect(ctx.provider.harnesses[0]?.readExit()).toStrictEqual({ exitCode: 0 });
  expect(menu.output.text).toBe('');
});

test('it draws nothing and logs no key for a session started before a scenario is loaded', () => {
  const ctx = setupTest();
  const idle = ctx.start();

  idle.harness.write(KEYS.enter);
  ctx.claude.load({ menus: [{ kind: 'plain', text: ['Pick a colour'], options: ['Amber'] }] });

  const menu = ctx.start();

  ctx.clock.advance(0);

  expect(menu.output.text).toInclude('❯ Amber');
  expect(idle.output.text).toBe('');
  expect(ctx.claude.log).toStrictEqual([]);
});
