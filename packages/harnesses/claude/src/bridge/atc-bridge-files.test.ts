import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';

test('it embeds the mod files exactly as the mods folder holds them', () => {
  const modFolder = join(import.meta.dir, '..', '..', '..', '..', '..', 'mods', 'atc-bridge');

  expect(Object.keys(ATC_BRIDGE_FILES).toSorted()).toStrictEqual([
    '.claude-plugin/plugin.json',
    'hooks/bridge-state.ts',
    'hooks/deliver-messages.ts',
    'hooks/hooks.json',
    'hooks/parse-tap-line.ts',
    'hooks/register.ts',
    'hooks/report-turns.ts',
    'hooks/run-tap.ts',
    'hooks/track-turns.ts',
  ]);

  for (const [path, content] of Object.entries(ATC_BRIDGE_FILES)) {
    expect(content).toBe(readFileSync(join(modFolder, path), 'utf8'));
  }
});
