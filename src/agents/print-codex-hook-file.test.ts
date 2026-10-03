import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('it prints Codex hook entries that report under the codex agent', async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'cli.ts'), 'codex-hooks'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);

  expect(JSON.parse(out)).toMatchObject({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(' hook-report --agent codex'),
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [{ command: expect.toEndWith(' hook-report --agent codex') }] }],
      PermissionRequest: [{ hooks: [{ command: expect.toEndWith(' hook-report --agent codex') }] }],
      Stop: [{ hooks: [{ command: expect.toEndWith(' hook-report --agent codex') }] }],
      SessionEnd: [
        { hooks: [{ command: expect.toEndWith(' hook-report --agent codex'), timeout: 3 }] },
      ],
    },
  });
});
