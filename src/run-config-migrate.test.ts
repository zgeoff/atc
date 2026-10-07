import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory for the config file under migration, and the CLI entry
 * the test runs under its own bun. Disposal removes the directory.
 */
function setupTest() {
  const tmp = setupTempDir('atc-config-migrate-');

  return {
    dir: tmp.dir,
    cli: join(import.meta.dir, 'cli.ts'),
    [Symbol.asyncDispose]: tmp[Symbol.asyncDispose],
  };
}

test('it prints the migrated config and leaves the file alone without --write', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ claudeBin: '/opt/claude', leader: 'ctrl-a' });

  writeFileSync(file, original);

  const proc = Bun.spawn([process.execPath, ctx.cli, 'config', 'migrate', '--file', file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ stdout, stderr, code, kept: readFileSync(file, 'utf8') }).toStrictEqual({
    stdout: `${JSON.stringify(
      { agents: { claude: { bin: '/opt/claude' }, grok: {}, codex: {} }, leader: 'ctrl-a' },
      null,
      2,
    )}\n`,
    stderr: '',
    code: 0,
    kept: original,
  });
});

test('it backs the file up, rewrites it, and prints both paths with --write', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ codexBin: '/opt/codex' });

  writeFileSync(file, original);

  const proc = Bun.spawn(
    [process.execPath, ctx.cli, 'config', 'migrate', '--file', file, '--write'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const [backupName, ...others] = readdirSync(ctx.dir).filter((name) => name !== 'config.json');

  if (backupName === undefined) {
    throw new Error('the migration wrote no backup');
  }

  const backup = join(ctx.dir, backupName);

  expect(backupName).toMatch(/^config\.json\.bak-\d{8}T\d{6}Z$/u);

  expect({
    stdout,
    stderr,
    code,
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

test('it says nothing to migrate and writes nothing for a file that uses agents', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, JSON.stringify({ agents: { claude: {} } }));

  const proc = Bun.spawn(
    [process.execPath, ctx.cli, 'config', 'migrate', '--file', file, '--write'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ stdout, stderr, code, entries: readdirSync(ctx.dir) }).toStrictEqual({
    stdout: 'config.json already uses agents; nothing to migrate\n',
    stderr: '',
    code: 0,
    entries: ['config.json'],
  });
});

test('it exits 1 and writes nothing for a file that sets agents beside an old key', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ agents: {}, claudeBin: 'x' });

  writeFileSync(file, original);

  const proc = Bun.spawn(
    [process.execPath, ctx.cli, 'config', 'migrate', '--file', file, '--write'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({
    stdout,
    stderr,
    code,
    entries: readdirSync(ctx.dir),
    kept: readFileSync(file, 'utf8'),
  }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file}: claudeBin cannot be set together with agents; move them into agents or run 'atc config migrate'\n`,
    code: 1,
    entries: ['config.json'],
    kept: original,
  });
});

test('it notes each dropped gateway on stderr without printing a value', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');

  writeFileSync(
    file,
    JSON.stringify({ gateways: { broken: { env: { TOKEN: 'sk-secret-value' } } } }),
  );

  const proc = Bun.spawn([process.execPath, ctx.cli, 'config', 'migrate', '--file', file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: `${JSON.stringify({ agents: { claude: {}, grok: {}, codex: {} } }, null, 2)}\n`,
    stderr: 'atc config migrate: gateways.broken is left out: it has no baseURL\n',
    code: 0,
  });
});

test('it exits 1 for a file that is not valid JSON', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, '{ "claudeBin": ');

  const proc = Bun.spawn([process.execPath, ctx.cli, 'config', 'migrate', '--file', file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} is not valid JSON\n`,
    code: 1,
  });
});

test('it exits 1 for a file that does not exist', async () => {
  await using ctx = setupTest();

  const file = join(ctx.dir, 'config.json');

  const proc = Bun.spawn([process.execPath, ctx.cli, 'config', 'migrate', '--file', file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ stdout, stderr, code, created: existsSync(file) }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} cannot be read\n`,
    code: 1,
    created: false,
  });
});
