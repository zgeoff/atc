import { expect, test } from 'bun:test';
import { renderAtcAnswer } from './render-atc-answer';

test('it renders an answered message with its answer', () => {
  expect(
    renderAtcAnswer({ id: 'm-1', from: 's-2', status: 'answered', answer: 'the build passes' }),
  ).toBe('<atc-answer id="m-1" from="s-2" status="answered">\nthe build passes\n</atc-answer>');
});

test('it renders an unanswered message with its reason', () => {
  expect(
    renderAtcAnswer({ id: 'm-1', from: 's-2', status: 'unanswered', reason: 'interrupted' }),
  ).toBe(
    '<atc-answer id="m-1" from="s-2" status="unanswered" reason="interrupted">\n\n</atc-answer>',
  );
});

test('it tells the sender to send again a message whose session ended before it answered', () => {
  expect(
    renderAtcAnswer({ id: 'm-1', from: 's-2', status: 'unanswered', reason: 'session_ended' }),
  ).toBe(
    '<atc-answer id="m-1" from="s-2" status="unanswered" reason="session_ended">\nThis message has no answer, because its session ended before it answered. Send it again if you still need the answer.\n</atc-answer>',
  );
});
