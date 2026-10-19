import { expect, test } from 'bun:test';
import { resolveConfiguredPluginDirs } from './resolve-configured-plugin-dirs';

test('it expands a leading ~ to the home it is given and keeps an absolute path', () => {
  expect(
    resolveConfiguredPluginDirs(['~/plugins/band', '/opt/plugins/shared', '~'], '/home/sam'),
  ).toStrictEqual(['/home/sam/plugins/band', '/opt/plugins/shared', '/home/sam']);
});

test('it gives each folder in its normal form, without a trailing slash or a dot segment', () => {
  expect(
    resolveConfiguredPluginDirs(['~/plugins/band/', '/opt/plugins/../plugins/shared'], '/home/sam'),
  ).toStrictEqual(['/home/sam/plugins/band', '/opt/plugins/shared']);
});

test('it resolves no folders for an entry that sets none', () => {
  expect(resolveConfiguredPluginDirs(undefined, '/home/sam')).toStrictEqual([]);
});
