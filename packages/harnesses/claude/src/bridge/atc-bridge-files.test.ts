import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';

test('it embeds the mod files exactly as the mods folder holds them', () => {
  const modFolder = join(import.meta.dir, '..', '..', '..', '..', '..', 'mods', 'atc-bridge');
  const readModFile = (path: string): string => readFileSync(join(modFolder, path), 'utf8');

  expect(ATC_BRIDGE_FILES).toStrictEqual({
    '.claude-plugin/plugin.json': readModFile('.claude-plugin/plugin.json'),
    'hooks/hooks.json': readModFile('hooks/hooks.json'),
    'hooks/register.ts': readModFile('hooks/register.ts'),
    'hooks/bridge-state.ts': readModFile('hooks/bridge-state.ts'),
    'hooks/encode-attribute.ts': readModFile('hooks/encode-attribute.ts'),
    'hooks/parse-tap-line.ts': readModFile('hooks/parse-tap-line.ts'),
    'hooks/run-tap.ts': readModFile('hooks/run-tap.ts'),
    'hooks/schedule-answered-report.ts': readModFile('hooks/schedule-answered-report.ts'),
    'hooks/schedule-delivery.ts': readModFile('hooks/schedule-delivery.ts'),
    'hooks/schedule-notice-delivery.ts': readModFile('hooks/schedule-notice-delivery.ts'),
    'hooks/schedule-notice-reminder.ts': readModFile('hooks/schedule-notice-reminder.ts'),
    'hooks/schedule-unanswered-report.ts': readModFile('hooks/schedule-unanswered-report.ts'),
    'hooks/try-update-conversation.ts': readModFile('hooks/try-update-conversation.ts'),
    'hooks/update-turn-completed.ts': readModFile('hooks/update-turn-completed.ts'),
    'hooks/update-turn-started.ts': readModFile('hooks/update-turn-started.ts'),
    'hooks/wait-for-step-end.ts': readModFile('hooks/wait-for-step-end.ts'),
  });
});
