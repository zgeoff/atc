import { expect, test } from 'bun:test';
import { findSlashCommand } from './find-slash-command';

test('it splits a slash command into its name with the following spaces and its argument', () => {
  expect(findSlashCommand('/goal  finish\nthe release')).toStrictEqual({
    name: '/goal  ',
    argument: 'finish\nthe release',
  });
});

test('it splits a namespaced slash command', () => {
  expect(findSlashCommand('/plugin:do-it_2 first')).toStrictEqual({
    name: '/plugin:do-it_2 ',
    argument: 'first',
  });
});

test.each([
  ['a bare command', '/clear'],
  ['a command whose argument is only spaces', '/clear  '],
  ['a command whose argument starts on the next line', '/goal\nfinish'],
  ['a path', '/tmp/out holds the log'],
  ['text before the slash', 'run /goal finish'],
])('it finds nothing in %s', (_label, text) => {
  expect(findSlashCommand(text)).toBeNull();
});
