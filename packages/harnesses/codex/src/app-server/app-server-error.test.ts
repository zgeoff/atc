import { expect, test } from 'bun:test';
import { AppServerError } from './app-server-error';

test('it carries the code and message the server answered', () => {
  const error = new AppServerError(-32_600, 'thread not loaded');

  expect(error).toMatchObject({
    name: 'AppServerError',
    code: -32_600,
    message: 'thread not loaded',
  });
});
