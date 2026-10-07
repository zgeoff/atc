import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { KEYS } from '../src/test-utils/keys';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it adopts a session with --resume and yanks its resume command', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('r');

  await ctx.waitFor('adopt: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: directory');

  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: name');

  ctx.reset();
  ctx.write(`adopted${KEYS.enter}`);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  expect(ctx.read()).toMatch(/FAKE_CLAUDE_UP args: [^\r\n]*--resume/u);

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: adopted');
  await ctx.waitFor('\u001B[7madopted');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('resume cmd copied');

  expect(ctx.read()).toInclude(
    `]52;c;${Buffer.from(`cd '${ctx.home}' && ${join(ctx.home, 'fake-claude')} --resume fake-1`).toString('base64')}${KEYS.bel}`,
  );
}, 15_000);

test('it adopts grok with --no-leader and without --resume', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('r');

  await ctx.waitFor('adopt: agent');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mGrok');

  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: directory');

  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: name');

  ctx.write(`adoptedg${KEYS.enter}`);

  await ctx.waitFor('FAKE_GROK_UP');

  const captured = ctx.read();

  // The TUI paints with cursor moves and no newlines, so the args reach the
  // capture on the same line as a whole screen of session names.
  expect(captured).toMatch(/FAKE_GROK_UP args: --no-leader/u);
  expect(captured).not.toMatch(/FAKE_GROK_UP args:[^\r\n]*(?:--resume|-p)/u);
  expect(captured).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it offers an adopt only the targets that run on this host', async () => {
  await using ctx = setupTest();

  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      alt: { provider: 'local-pty', tag: 'alt' },
      box: { provider: 'imp', url: 'http://127.0.0.1:9' },
    },
    defaultTarget: 'local',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('r');

  await ctx.waitFor('adopt: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: directory');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('adopt: target');

  const menu = ctx.read();

  expect(menu).toInclude('local  local-pty · default');
  expect(menu).toInclude('alt  local-pty');
  expect(menu).not.toInclude('box  imp');
}, 15_000);
