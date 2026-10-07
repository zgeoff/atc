import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { printCodexHookFile } from './print-codex-hook-file';

test('it prints Codex hook entries that report under the codex agent', () => {
  const command = `"${process.execPath}" "${join(import.meta.dir, '..', 'cli.ts')}" hook-report --agent codex`;
  const printed: string[] = [];

  printCodexHookFile((text) => {
    printed.push(text);
  });

  expect(printed.map((text): unknown => JSON.parse(text))).toStrictEqual([
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 3 }] }],
      },
    },
  ]);
});
