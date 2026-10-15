import { expect, test } from 'bun:test';
import { findAnswerSchema } from './find-answer-schema';

test('it finds the output schema of a nested procedure', () => {
  const schema = findAnswerSchema('session.auth.rebind');

  expect(schema?.safeParse({ revision: 3, restartPending: ['s1'] }).data).toStrictEqual({
    revision: 3,
    restartPending: ['s1'],
  });
});

test('it finds the output schema that refuses an answer missing a field', () => {
  const schema = findAnswerSchema('session.screen');

  expect(schema?.safeParse({ text: '', cols: 80 }).error?.issues).toPartiallyContain({
    path: ['rows'],
  });
});

test.each([['daemon.nuke'], ['session'], ['session.auth'], ['']])(
  'it finds no schema for %p, which is no procedure',
  (method) => {
    expect(findAnswerSchema(method)).toBeNull();
  },
);
