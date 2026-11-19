import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';

test('it embeds the mod files exactly as the mods folder holds them', () => {
  const modFolder = join(import.meta.dir, '..', '..', '..', '..', '..', 'mods', 'atc-bridge');

  expect(Object.keys(ATC_BRIDGE_FILES).toSorted()).toStrictEqual([
    '.claude-plugin/plugin.json',
    'hooks/bridge-state.ts',
    'hooks/encode-attribute.ts',
    'hooks/hooks.json',
    'hooks/parse-tap-line.ts',
    'hooks/register.ts',
    'hooks/run-tap.ts',
    'hooks/schedule-answered-report.ts',
    'hooks/schedule-delivery.ts',
    'hooks/schedule-notice-delivery.ts',
    'hooks/schedule-notice-reminder.ts',
    'hooks/schedule-unanswered-report.ts',
    'hooks/try-update-conversation.ts',
    'hooks/update-turn-completed.ts',
    'hooks/update-turn-started.ts',
    'hooks/wait-for-step-end.ts',
  ]);

  for (const [path, content] of Object.entries(ATC_BRIDGE_FILES)) {
    expect(content).toBe(readFileSync(join(modFolder, path), 'utf8'));
  }
});
