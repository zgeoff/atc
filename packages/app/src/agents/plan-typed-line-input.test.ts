import { expect, test } from 'bun:test';
import { planTypedLineInput } from './plan-typed-line-input';

test('it types a line and its newline in one write', () => {
  expect(planTypedLineInput('hello')).toStrictEqual(['hello\n']);
});
