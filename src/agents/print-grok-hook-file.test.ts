import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { printGrokHookFile } from './print-grok-hook-file';

// The Grok home the printer runs under.
function setupTest() {
  return setupTempDir('atc-grok-hooks-');
}

test('it prints the Grok hook file that reports under the grok agent', () => {
  const command = `"${process.execPath}" "${join(import.meta.dir, '..', 'cli.ts')}" hook-report --agent grok`;
  const printed: string[] = [];

  printGrokHookFile((text) => {
    printed.push(text);
  });

  expect(printed.map((text): unknown => JSON.parse(text))).toStrictEqual([
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopFailure: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopCancelled: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Notification: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      },
    },
  ]);
});

test('it writes nothing under GROK_HOME while it prints the hook file', () => {
  using ctx = setupTest();

  updateEnv('GROK_HOME', ctx.dir);
  printGrokHookFile(() => {});

  expect(readdirSync(ctx.dir)).toStrictEqual([]);
});
