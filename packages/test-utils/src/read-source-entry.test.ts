import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readSourceEntry } from './read-source-entry';
import { updateEnv } from './update-env';

test('it returns the atc entry the wrapper exports', () => {
  updateEnv('ATC_CLI_ENTRY', '/repo/packages/app/src/cli.ts');

  expect(readSourceEntry('atc')).toBe('/repo/packages/app/src/cli.ts');
});

test('it returns the atc-gateway entry the wrapper exports', () => {
  updateEnv('ATC_GATEWAY_ENTRY', '/repo/packages/app/src/gateway.ts');

  expect(readSourceEntry('atc-gateway')).toBe('/repo/packages/app/src/gateway.ts');
});

test('it throws when the wrapper set no entry', () => {
  updateEnv('ATC_CLI_ENTRY', undefined);

  expect(() => readSourceEntry('atc')).toThrowWithMessage(
    Error,
    'ATC_CLI_ENTRY is unset: run tests through scripts/with-test-home.sh',
  );
});

test('it points the wrapper entries at the app package sources', () => {
  const root = join(import.meta.dir, '..', '..', '..');

  expect(readSourceEntry('atc')).toBe(join(root, 'packages', 'app', 'src', 'cli.ts'));
  expect(readSourceEntry('atc-gateway')).toBe(join(root, 'packages', 'app', 'src', 'gateway.ts'));
});
