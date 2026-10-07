import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A temp directory for the config file under migration, which is also the
 * home the CLI runs with. Disposal removes the directory.
 */
function setupTest() {
  return setupTempDir('atc-e2e-config-migrate-');
}

test('it backs the file up, rewrites it, and prints both paths with --write', async () => {
  using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ codexBin: '/opt/codex' });

  writeFileSync(file, original);

  const migrated = await runATC({
    command: resolveATCCommand(),
    args: ['config', 'migrate', '--file', file, '--write'],
    home: ctx.dir,
  });

  const [backupName, ...others] = readdirSync(ctx.dir).filter((name) => name !== 'config.json');

  invariant(backupName !== undefined, 'the migration wrote no backup');

  const backup = join(ctx.dir, backupName);

  expect(backupName).toMatch(/^config\.json\.bak-\d{8}T\d{6}Z$/u);

  expect({
    stdout: migrated.stdout,
    stderr: migrated.stderr,
    code: migrated.exitCode,
    others,
    backedUp: readFileSync(backup, 'utf8'),
    rewritten: JSON.parse(readFileSync(file, 'utf8')) as unknown,
  }).toStrictEqual({
    stdout: `backup: ${backup}\nwrote: ${file}\n`,
    stderr: '',
    code: 0,
    others: [],
    backedUp: original,
    rewritten: { agents: { claude: {}, grok: {}, codex: { bin: '/opt/codex' } } },
  });
});
