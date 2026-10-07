import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('it prints Codex hook entries that report under the codex agent', async () => {
  const cliPath = join(import.meta.dir, '..', 'cli.ts');
  const command = `"${process.execPath}" "${cliPath}" hook-report --agent codex`;

  const proc = Bun.spawn([process.execPath, cliPath, 'codex-hooks'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  const file: unknown = JSON.parse(out);

  expect({ code, file }).toStrictEqual({
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
