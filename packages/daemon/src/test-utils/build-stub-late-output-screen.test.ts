import { expect, onTestFinished, test } from 'bun:test';
import { createScreenModel } from '../sessions/create-screen-model';
import { buildStubLateOutputScreen } from './build-stub-late-output-screen';

test('it records the late output after the replay renders, and the mark comes from before it', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  const printed: string[] = [];

  const screen = buildStubLateOutputScreen(model, () => {
    printed.push('late output');
    model.record('late output');
  });

  model.record('early output');

  const captured = await screen.captureFullReplay(() => printed.length);
  const text = await model.captureText();

  expect(captured.replay).toInclude('early output');
  expect(captured.replay).not.toInclude('late output');
  expect(captured.mark).toBe(0);
  expect(text.text).toInclude('late output');
});
