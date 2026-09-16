import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('it prints the Muse hook entries and leaves the user settings file untouched', async () => {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const configHome = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config');
  const settingsPath = join(configHome, 'muse', 'settings.json');
  const before = readSettings(settingsPath);

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'cli.ts'), 'muse-hooks'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(out).toInclude('SessionStart');
  expect(out).toInclude('UserPromptSubmit');
  expect(out).toInclude('PermissionRequest');
  expect(out).toInclude('Notification');
  expect(out).toInclude('Stop');
  expect(out).toInclude('SessionEnd');
  expect(out).toInclude('hook-report');

  // Muse takes its hook timeout in milliseconds, unlike Claude's whole seconds.
  expect(JSON.parse(out)).toMatchObject({
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', timeout_ms: 5000 }] }],
    },
  });

  expect(readSettings(settingsPath)).toBe(before);
});

// null covers both "no settings file" and "unreadable", which are the same
// thing for this test: printing must not create or change it either way.
function readSettings(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
