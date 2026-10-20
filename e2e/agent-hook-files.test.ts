import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveATCCommand, runATC, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-hook-files-');

  return { home: temporaryDirectory.path };
}

test('it prints Codex hook entries that report under the codex agent', async () => {
  const ctx = setupTest();
  const atc = resolveATCCommand();
  const command = `${atc.map((part) => `"${part}"`).join(' ')} hook-report --agent codex`;

  const printed = await runATC({ command: atc, args: ['codex-hooks'], home: ctx.home });

  const file: unknown = JSON.parse(printed.stdout);

  expect({ code: printed.exitCode, file }).toStrictEqual({
    code: 0,
    file: {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 3 }] }],
      },
    },
  });
});

test('it prints the Grok hook file that reports under the grok agent and writes nothing under GROK_HOME', async () => {
  const ctx = setupTest();
  const grokHome = join(ctx.home, 'grok');

  mkdirSync(grokHome);

  const atc = resolveATCCommand();
  const command = `${atc.map((part) => `"${part}"`).join(' ')} hook-report --agent grok`;

  const printed = await runATC({
    command: atc,
    args: ['grok-hooks'],
    home: ctx.home,
    env: { GROK_HOME: grokHome },
  });

  const file: unknown = JSON.parse(printed.stdout);

  expect({ code: printed.exitCode, file }).toStrictEqual({
    code: 0,
    file: {
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
  });

  expect(readdirSync(grokHome)).toStrictEqual([]);
});
