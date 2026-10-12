import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printCodexHookFile } from './print-codex-hook-file';

test('it prints Codex hook entries that report under the codex agent', () => {
  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));
  const command = `"${process.execPath}" "${join(repoRoot, 'src/cli.ts')}" hook-report --agent codex`;
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
