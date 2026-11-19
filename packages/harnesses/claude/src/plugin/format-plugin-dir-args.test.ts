import { expect, test } from 'bun:test';
import { formatPluginDirArgs } from './format-plugin-dir-args';

test('it formats each folder once, in order, as a quoted --plugin-dir argument', () => {
  expect(
    formatPluginDirArgs(['/opt/plugins/shared', "/srv/sam's plugins", '/opt/plugins/shared']),
  ).toBe(` --plugin-dir '/opt/plugins/shared' --plugin-dir '/srv/sam'\\''s plugins'`);
});

test('it formats no folders as an empty string', () => {
  expect(formatPluginDirArgs([])).toBe('');
});
