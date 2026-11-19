import { expect, test } from 'bun:test';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { buildGuestBridgeFiles } from './build-guest-bridge-files';

test("it places the mod's files in the guest folder's mod folder, running the host's atc", () => {
  expect(buildGuestBridgeFiles(['/opt/atc/bin/atc'])).toStrictEqual({
    'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
    'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
    'atc-bridge/hooks/bridge-state.ts': ATC_BRIDGE_FILES['hooks/bridge-state.ts'],
    'atc-bridge/hooks/encode-attribute.ts': ATC_BRIDGE_FILES['hooks/encode-attribute.ts'],
    'atc-bridge/hooks/parse-tap-line.ts': ATC_BRIDGE_FILES['hooks/parse-tap-line.ts'],
    'atc-bridge/hooks/run-tap.ts': ATC_BRIDGE_FILES['hooks/run-tap.ts'],
    'atc-bridge/hooks/schedule-answered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-answered-report.ts'],
    'atc-bridge/hooks/schedule-delivery.ts': ATC_BRIDGE_FILES['hooks/schedule-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-delivery.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-reminder.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-reminder.ts'],
    'atc-bridge/hooks/schedule-unanswered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-unanswered-report.ts'],
    'atc-bridge/hooks/try-update-conversation.ts':
      ATC_BRIDGE_FILES['hooks/try-update-conversation.ts'],
    'atc-bridge/hooks/update-turn-completed.ts': ATC_BRIDGE_FILES['hooks/update-turn-completed.ts'],
    'atc-bridge/hooks/update-turn-started.ts': ATC_BRIDGE_FILES['hooks/update-turn-started.ts'],
    'atc-bridge/hooks/wait-for-step-end.ts': ATC_BRIDGE_FILES['hooks/wait-for-step-end.ts'],
    'atc-bridge/hooks/atc-cli.ts':
      'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  });
});

test('it marks a rewrite of the guest copy with the time it was written', () => {
  expect(
    buildGuestBridgeFiles(['/opt/atc/bin/atc'], 1_793_000_000_000)['atc-bridge/hooks/atc-cli.ts'],
  ).toBe(
    'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n' +
      '// written again at 1793000000000: Claude Code loads a mod again only when a file of it changes\n',
  );
});
