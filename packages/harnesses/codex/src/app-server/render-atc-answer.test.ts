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
