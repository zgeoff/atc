import { expect, onTestFinished, test } from 'bun:test';
import { RESET_INPUT_MODES } from '../shared/reset-input-modes';
import { waitFor } from '../test-utils/wait-for';
import { ScreenModel } from './screen-model';

test('it replays text written to the screen', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello fleet');

  const replay = await model.renderReplay();

  expect(replay).toInclude('hello fleet');
});

test('it drops cleared content from the replay', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('stale screen\r\n');

  // A replay waits for every byte recorded before it.
  await model.renderReplay();

  model.record('\u001B[2J\u001B[Hfresh screen');

  const replay = await model.renderReplay();

  expect(replay).toInclude('fresh screen');
  expect(replay).not.toInclude('stale screen');
});

test('it includes bytes recorded while a replay is pending', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('first');

  // A replay waits for every byte recorded before it.
  await model.renderReplay();

  const replay = model.renderReplay();

  model.record(' second');

  const rendered = await replay;

  expect(rendered).toInclude('second');
});

test('it replays only the visible screen for a session on the alternate buffer', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('normal residue\r\n\u001B[?1049haltscreen content');

  const replay = await model.renderReplay();

  expect(replay).toInclude('altscreen content');
  expect(replay).not.toInclude('\u001B[?1049h');
  expect(replay).not.toInclude('normal residue');
});

test('it preserves colors and cursor positioning in the replay', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[5;10H\u001B[1;31malert\u001B[0m');

  const replay = await model.renderReplay();

  // The replay reaches row 5 by four line breaks and column 10 by a
  // nine-column move, then sets bold red.
  expect(replay).toEndWith('\r\n\r\n\r\n\r\n\u001B[9C\u001B[31;1malert\u001B[0m');
});

test('it keeps replaying after a resize', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('before resize\r\n');

  // A replay waits for every byte recorded before it.
  await model.renderReplay();

  model.updateDims(30, 8);
  model.record('after resize');

  const replay = await model.renderReplay();

  expect(replay).toInclude('after resize');
});

test('it re-emits SGR mouse encoding and alternate scroll in the replay', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?1000h\u001B[?1006h\u001B[?1007h');

  const replay = await model.renderReplay();

  expect(replay).toInclude('\u001B[?1006h');
  expect(replay).toInclude('\u001B[?1007h');
});

test('it restores the kitty keyboard push and modifyOtherKeys in the replay', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[>1u\u001B[>4;2m');

  const replay = await model.renderReplay();

  expect(replay).toInclude('\u001B[>1u');
  expect(replay).toInclude('\u001B[>4;2m');
});

test('it drops popped and reset input modes from the replay', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?1006h\u001B[>1u\u001B[>4;2m');
  model.record('\u001B[?1006l\u001B[<u\u001B[>4;0m');
  model.record('modes reset');

  const replay = await model.renderReplay();

  expect(replay).toInclude('modes reset');
  expect(replay).not.toInclude('\u001B[?1006h');
  expect(replay).not.toInclude('\u001B[>1u');
  expect(replay).not.toInclude('\u001B[>4;2m');
});

test('it re-emits a mode whose set sequence arrived split across chunks', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?10');
  model.record('06h');

  const replay = await model.renderReplay();

  expect(replay).toInclude('\u001B[?1006h');
});

test('it leads the replay with an input-mode reset', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello');

  const replay = await model.renderReplay();

  expect(replay).toStartWith(RESET_INPUT_MODES);
});

test('it renders the visible screen as plain text with trailing blank rows dropped', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello fleet\r\n\u001B[32msecond\u001B[0m   ');

  const screen = await waitFor(async () => {
    const rendered = await model.renderText();

    expect(rendered.text).toInclude('second');

    return rendered;
  });

  expect(screen).toStrictEqual({ text: 'hello fleet\nsecond', cols: 40, rows: 10 });
});

test('it renders only the alternate buffer as text for a session on the alternate screen', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('normal screen\r\n');

  // A replay waits for every byte recorded before it.
  await model.renderReplay();

  model.record('\u001B[?1049h\u001B[Halternate screen');

  const screen = await waitFor(async () => {
    const rendered = await model.renderText();

    expect(rendered.text).toInclude('alternate screen');

    return rendered;
  });

  expect(screen.text).toBe('alternate screen');
});

test('it reports bracketed paste on once the tui turns it on', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?2004h');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeTrue();
  });
});

test('it reports bracketed paste off once the tui turns it off', async () => {
  const model = new ScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?2004h');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeTrue();
  });

  model.record('\u001B[?2004l');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeFalse();
  });
});
