import { expect, test } from 'bun:test';
import { buildPromptSubmittedEvent } from './build-prompt-submitted-event';

test('it previews the prompt on top of the base event', () => {
  expect(
    buildPromptSubmittedEvent({ kind: 'heartbeat', nameSource: '/t.jsonl' }, 'fix the build'),
  ).toStrictEqual({
    kind: 'prompt-submitted',
    nameSource: '/t.jsonl',
    message: 'fix the build',
    detail: 'fix the build',
  });
});

test("it previews only the prompt's first eighty characters", () => {
  const event = buildPromptSubmittedEvent({ kind: 'heartbeat' }, 'x'.repeat(200));

  expect(event.message).toBe('x'.repeat(80));
});

test('it leaves out the preview of an empty prompt', () => {
  expect(buildPromptSubmittedEvent({ kind: 'heartbeat' }, '')).toStrictEqual({
    kind: 'prompt-submitted',
  });
});

test('it leaves out the preview of a line with no prompt', () => {
  expect(buildPromptSubmittedEvent({ kind: 'heartbeat' }, undefined)).toStrictEqual({
    kind: 'prompt-submitted',
  });
});
