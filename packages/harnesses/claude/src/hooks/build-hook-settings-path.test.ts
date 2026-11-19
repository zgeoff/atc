import { expect, test } from 'bun:test';
import { buildHookSettingsPath } from './build-hook-settings-path';

test('it names the settings file of a profile inside the directory', () => {
  const path = buildHookSettingsPath('/home/u/.local/state/atc', 'zai');

  expect(path).toBe('/home/u/.local/state/atc/hook-settings-zai.json');
});
