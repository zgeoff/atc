import { expect, test } from 'bun:test';
import { resolveConfiguredPluginDirs } from './resolve-configured-plugin-dirs';

test('it gives each configured folder in its normal form, under the home it is given', () => {
  expect(
    resolveConfiguredPluginDirs(['~/plugins/band/', '/opt/./plugins//shared'], '/home/sam'),
  ).toStrictEqual(['/home/sam/plugins/band', '/opt/plugins/shared']);
});

test('it resolves no folders for an entry that sets none', () => {
  expect(resolveConfiguredPluginDirs(undefined, '/home/sam')).toStrictEqual([]);
});
