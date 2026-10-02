import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';

test('it embeds the mod files exactly as the mods folder holds them', () => {
  expect(ATC_BRIDGE_FILES).toStrictEqual({
    '.claude-plugin/plugin.json': readFileSync(
      join(import.meta.dir, '..', '..', 'mods', 'atc-bridge', '.claude-plugin', 'plugin.json'),
      'utf8',
    ),
    'hooks/hooks.json': readFileSync(
      join(import.meta.dir, '..', '..', 'mods', 'atc-bridge', 'hooks', 'hooks.json'),
      'utf8',
    ),
    'hooks/register.ts': readFileSync(
      join(import.meta.dir, '..', '..', 'mods', 'atc-bridge', 'hooks', 'register.ts'),
      'utf8',
    ),
  });
});
