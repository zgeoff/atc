import { expect, test } from 'bun:test';
import { isCompiledBinary } from './is-compiled-binary';

test('it reports a source run under bun as not compiled', () => {
  expect(isCompiledBinary()).toBeFalse();
});
