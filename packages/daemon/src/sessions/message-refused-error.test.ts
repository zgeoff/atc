import { expect, test } from 'bun:test';
import { MessageRefusedError } from './message-refused-error';

test('it carries the refusal it was thrown with', () => {
  const error = new MessageRefusedError('no_tap');

  expect(error).toMatchObject({
    name: 'MessageRefusedError',
    message: 'message refused: no_tap',
    refusal: 'no_tap',
  });
});
