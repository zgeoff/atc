import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';

// The Grok home the printing CLI is started with.
function setupTest() {
  return setupTempDir('atc-grok-hooks-');
}

test('it prints the Grok hook file that reports under the grok agent', async () => {
  await using ctx = setupTest();

  const cliPath = join(import.meta.dir, '..', 'cli.ts');
  const command = `"${process.execPath}" "${cliPath}" hook-report --agent grok`;

  const proc = Bun.spawn([process.execPath, cliPath, 'grok-hooks'], {
    env: { ...process.env, GROK_HOME: ctx.dir },
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
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopFailure: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopCancelled: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Notification: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      },
    },
  });
});

test('it writes nothing under GROK_HOME while it prints the hook file', async () => {
  await using ctx = setupTest();

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'cli.ts'), 'grok-hooks'], {
    env: { ...process.env, GROK_HOME: ctx.dir },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const code = await proc.exited;

  expect({ code, files: readdirSync(ctx.dir) }).toStrictEqual({ code: 0, files: [] });
});
