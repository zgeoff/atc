import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('it prints the Grok hook file and writes nothing under GROK_HOME', async () => {
  const home = process.env['GROK_HOME'];
  const grokHome = home !== undefined && home !== '' ? home : join(homedir(), '.grok');
  const hookPath = join(grokHome, 'hooks', 'atc-reporter.json');
  const before = existsSync(hookPath);

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'cli.ts'), 'grok-hooks'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(out).toInclude('SessionStart');
  expect(out).toInclude('SessionEnd');
  expect(out).toInclude('UserPromptSubmit');
  expect(out).toInclude('StopFailure');
  expect(out).toInclude('StopCancelled');
  expect(out).toInclude('Notification');
  expect(out).toInclude('hook-report');

  expect(JSON.parse(out)).toMatchObject({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', timeout: 5 }] }],
    },
  });

  expect(existsSync(hookPath)).toBe(before);
});
