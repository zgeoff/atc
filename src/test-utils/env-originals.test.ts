import { expect, test } from 'bun:test';
import { envOriginals } from './env-originals';
import { updateEnv } from './update-env';

test('it keeps the value a variable held before its first override across repeated overrides', () => {
  const original = process.env['GROK_HOME'];

  updateEnv('GROK_HOME', '/first/override');
  updateEnv('GROK_HOME', '/second/override');

  expect([...envOriginals]).toContainEqual(['GROK_HOME', original]);
});

test('it records a variable that was unset as undefined', () => {
  updateEnv('ATC_TEST_ENV_ORIGINALS_UNSET', 'overridden');

  expect([...envOriginals]).toContainEqual(['ATC_TEST_ENV_ORIGINALS_UNSET', undefined]);
});
