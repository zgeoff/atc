import { expect, test } from 'bun:test';
import { buildStubLog } from './build-stub-log';

test('it starts with no lines', () => {
  expect(buildStubLog().lines).toBeEmpty();
});

test('it records each line it is given in order', () => {
  const stub = buildStubLog();

  stub.log('first');
  stub.log('second');

  expect(stub.lines).toStrictEqual(['first', 'second']);
});
