import { expect, test } from 'bun:test';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { buildGuestBridgeFiles } from './build-guest-bridge-files';

test("it places the mod's files in the guest folder's mod folder, running the host's atc", () => {
  expect(buildGuestBridgeFiles(['/opt/atc/bin/atc'])).toStrictEqual({
    'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
    'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
    'atc-bridge/hooks/atc-cli.ts':
      'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  });
});
