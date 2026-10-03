import { expect, test } from 'bun:test';
import { normalizeCLIArgs } from './normalize-cli-args';

test('it joins a revoke value that starts with a dash onto its flag', () => {
  expect(normalizeCLIArgs(['grants', '--revoke', '-a_b'])).toStrictEqual([
    'grants',
    '--revoke=-a_b',
  ]);
});

test('it leaves an inline revoke value and every other argument as they are', () => {
  expect(normalizeCLIArgs(['grants', '--revoke=-a_b'])).toStrictEqual(['grants', '--revoke=-a_b']);

  expect(normalizeCLIArgs(['mcp', '--http', '--port', '8414'])).toStrictEqual([
    'mcp',
    '--http',
    '--port',
    '8414',
  ]);
});

test('it leaves a revoke flag with no value for the parser to report', () => {
  expect(normalizeCLIArgs(['grants', '--revoke'])).toStrictEqual(['grants', '--revoke']);
});

test('it leaves arguments after a double dash untouched', () => {
  expect(normalizeCLIArgs(['--', '--revoke', '-a_b'])).toStrictEqual(['--', '--revoke', '-a_b']);
});
