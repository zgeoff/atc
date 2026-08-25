import { expect, onTestFinished, test } from 'bun:test';
import { RESET_INPUT_MODES } from '../shared/reset-input-modes';
import { ScreenModel } from './screen-model';

interface ModelContext {
  readonly model: ScreenModel;
  readonly waitForReplay: (needle: string) => Promise<string>;
}

function setupModel(cols = 40, rows = 10): ModelContext {
  const model = new ScreenModel(cols, rows);

  onTestFinished(() => {
    model.stop();
  });

  const waitForReplay = async (needle: string): Promise<string> => {
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
      const replay = await model.renderReplay();

      if (replay.includes(needle)) {
        return replay;
      }

      await Bun.sleep(10);
    }

    throw new Error(`replay never contained ${JSON.stringify(needle)}`);
  };

  return { model, waitForReplay };
}

test('it replays text written to the screen', async () => {
  const ctx = setupModel();

  ctx.model.record('hello fleet');

  const replay = await ctx.waitForReplay('hello fleet');

  expect(replay).toInclude('hello fleet');
});

test('it drops cleared content from the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('stale screen\r\n');

  await ctx.waitForReplay('stale screen');

  ctx.model.record('[2J[Hfresh screen');

  const replay = await ctx.waitForReplay('fresh screen');

  expect(replay).not.toInclude('stale screen');
});

test('it includes bytes recorded while a replay is pending', async () => {
  const ctx = setupModel();

  ctx.model.record('first');

  await ctx.waitForReplay('first');

  const replay = ctx.model.renderReplay();

  ctx.model.record(' second');

  const rendered = await replay;

  expect(rendered).toInclude('second');
});

test('it preserves colors and cursor positioning in the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('[5;10H[1;31malert[0m');

  const replay = await ctx.waitForReplay('alert');

  expect(replay).toInclude('[');
});

test('it keeps replaying after a resize', async () => {
  const ctx = setupModel();

  ctx.model.record('before resize\r\n');

  await ctx.waitForReplay('before resize');

  ctx.model.updateDims(30, 8);
  ctx.model.record('after resize');

  const replay = await ctx.waitForReplay('after resize');

  expect(replay).toInclude('after resize');
});

test('it re-emits SGR mouse encoding and alternate scroll in the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('\u001B[?1000h\u001B[?1006h\u001B[?1007h');

  const replay = await ctx.model.renderReplay();

  expect(replay).toInclude('\u001B[?1006h');
  expect(replay).toInclude('\u001B[?1007h');
});

test('it restores the kitty keyboard push and modifyOtherKeys in the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('\u001B[>1u\u001B[>4;2m');

  const replay = await ctx.model.renderReplay();

  expect(replay).toInclude('\u001B[>1u');
  expect(replay).toInclude('\u001B[>4;2m');
});

test('it drops popped and reset input modes from the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('\u001B[?1006h\u001B[>1u\u001B[>4;2m');
  ctx.model.record('\u001B[?1006l\u001B[<u\u001B[>4;0m');

  const replay = await ctx.model.renderReplay();

  expect(replay).not.toInclude('\u001B[?1006h');
  expect(replay).not.toInclude('\u001B[>1u');
  expect(replay).not.toInclude('\u001B[>4;2m');
});

test('it re-emits a mode whose set sequence arrived split across chunks', async () => {
  const ctx = setupModel();

  ctx.model.record('\u001B[?10');
  ctx.model.record('06h');

  const replay = await ctx.model.renderReplay();

  expect(replay).toInclude('\u001B[?1006h');
});

test('it leads the replay with an input-mode reset', async () => {
  const ctx = setupModel();

  ctx.model.record('hello');

  const replay = await ctx.model.renderReplay();

  expect(replay).toStartWith(RESET_INPUT_MODES);
});
