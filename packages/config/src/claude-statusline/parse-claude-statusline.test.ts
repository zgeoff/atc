import { expect, test } from 'bun:test';
import { parseClaudeStatusLine } from './parse-claude-statusline';

test('it reads the statusline command and padding', () => {
  expect(
    parseClaudeStatusLine('{"statusLine":{"type":"command","command":"ccline","padding":2}}'),
  ).toStrictEqual({ command: 'ccline', padding: 2 });
});

test('it reads settings with no statusline as none', () => {
  expect(parseClaudeStatusLine('{"model":"opus"}')).toStrictEqual({});
});

test('it leaves out a field of the wrong type and keeps the other', () => {
  expect(parseClaudeStatusLine('{"statusLine":{"command":7,"padding":1}}')).toStrictEqual({
    padding: 1,
  });
});

test('it reads a statusline that is not an object as none', () => {
  expect(parseClaudeStatusLine('{"statusLine":"ccline"}')).toStrictEqual({});
});

test('it reads text that is not JSON as no statusline', () => {
  expect(parseClaudeStatusLine('{"statusLine":')).toStrictEqual({});
});
