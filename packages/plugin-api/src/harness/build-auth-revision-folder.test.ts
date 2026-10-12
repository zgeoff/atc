import { expect, test } from 'bun:test';
import { buildAuthRevisionFolder } from './build-auth-revision-folder';

test('it names the folder after the binding revision', () => {
  expect(buildAuthRevisionFolder(3)).toBe('auth-r3');
});
