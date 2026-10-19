import { expect, test } from 'bun:test';
import { resolveConfiguredPluginDirs } from './resolve-configured-plugin-dirs';

test('it expands a leading ~ to the home it is given and keeps an absolute path', () => {
  expect(
    resolveConfiguredPluginDirs(['~/plugins/band', '/opt/plugins/shared', '~'], '/home/sam'),
  ).toStrictEqual(['/home/sam/plugins/band', '/opt/plugins/shared', '/home/sam']);
});

test('it resolves no folders for an entry that sets none', () => {
  expect(resolveConfiguredPluginDirs(undefined, '/home/sam')).toStrictEqual([]);
});
