import { expect, test } from 'bun:test';
import { toScopeFilePath } from './to-scope-file-path';

test('it names the scope file beside the record', () => {
  expect(toScopeFilePath('/state/records/8f3c2a1e.json')).toBe(
    '/state/records/8f3c2a1e.scope.json',
  );
});
