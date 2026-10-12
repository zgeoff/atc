import { expect, test } from 'bun:test';
import { buildHookCommand } from './build-hook-command';

test('it quotes each part of the atc argv before the subcommand', () => {
  expect(buildHookCommand('hook-report --agent grok', ['/usr/bin/bun', '/opt/atc/cli.ts'])).toBe(
    '"/usr/bin/bun" "/opt/atc/cli.ts" hook-report --agent grok',
  );
});

test('it runs a compiled atc as the whole argv', () => {
  expect(buildHookCommand('statusline --agent claude', ['/opt/atc/bin/atc'])).toBe(
    '"/opt/atc/bin/atc" statusline --agent claude',
  );
});
