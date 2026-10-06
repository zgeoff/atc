import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test/setup-temp-dir';

const CLI_PATH = join(import.meta.dir, 'cli.ts');

async function runMigrate(file: string, ...flags: readonly string[]) {
  const proc = Bun.spawn(['bun', CLI_PATH, 'config', 'migrate', '--file', file, ...flags], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code };
}

test('it prints the migrated config and leaves the file alone without --write', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');
  const original = JSON.stringify({ claudeBin: '/opt/claude', leader: 'ctrl-a' });

  writeFileSync(file, original);

  const result = await runMigrate(file);

  expect(result).toStrictEqual({
    stdout: `${JSON.stringify(
      { agents: { claude: { bin: '/opt/claude' }, grok: {}, codex: {} }, leader: 'ctrl-a' },
      null,
      2,
    )}\n`,
    stderr: '',
    code: 0,
  });

  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('it backs the file up, rewrites it, and prints both paths with --write', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');
  const original = JSON.stringify({ codexBin: '/opt/codex' });

  writeFileSync(file, original);

  const result = await runMigrate(file, '--write');

  const backups = readdirSync(tmp.dir).filter((name) => name.startsWith('config.json.bak-'));

  expect(backups).toHaveLength(1);

  const backup = join(tmp.dir, backups[0] ?? '');

  expect(backup).toMatch(/config\.json\.bak-\d{8}T\d{6}Z$/u);
  expect(readFileSync(backup, 'utf8')).toBe(original);

  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
    agents: { claude: {}, grok: {}, codex: { bin: '/opt/codex' } },
  });

  expect(result).toStrictEqual({
    stdout: `backup: ${backup}\nwrote: ${file}\n`,
    stderr: '',
    code: 0,
  });
});

test('it says nothing to migrate and writes nothing for a file that uses agents', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');

  writeFileSync(file, JSON.stringify({ agents: { claude: {} } }));

  const result = await runMigrate(file, '--write');

  expect(result).toStrictEqual({
    stdout: 'config.json already uses agents; nothing to migrate\n',
    stderr: '',
    code: 0,
  });

  expect(readdirSync(tmp.dir)).toStrictEqual(['config.json']);
});

test('it exits 1 and writes nothing for a file that sets agents beside an old key', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');
  const original = JSON.stringify({ agents: {}, claudeBin: 'x' });

  writeFileSync(file, original);

  const result = await runMigrate(file, '--write');

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file}: claudeBin cannot be set together with agents; move them into agents or run 'atc config migrate'\n`,
    code: 1,
  });

  expect(readdirSync(tmp.dir)).toStrictEqual(['config.json']);
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('it notes each dropped gateway on stderr without printing a value', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');

  writeFileSync(
    file,
    JSON.stringify({ gateways: { broken: { env: { TOKEN: 'sk-secret-value' } } } }),
  );

  const result = await runMigrate(file);

  expect({ stderr: result.stderr, code: result.code }).toStrictEqual({
    stderr: 'atc config migrate: gateways.broken is left out: it has no baseURL\n',
    code: 0,
  });

  expect(result.stdout).not.toInclude('sk-secret-value');
});

test('it exits 1 for a file that is not valid JSON', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');

  writeFileSync(file, '{ "claudeBin": ');

  const result = await runMigrate(file);

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} is not valid JSON\n`,
    code: 1,
  });
});

test('it exits 1 for a file that does not exist', async () => {
  using tmp = setupTempDir('atc-config-migrate-');

  const file = join(tmp.dir, 'config.json');

  const result = await runMigrate(file);

  expect(result.code).toBe(1);
  expect(existsSync(file)).toBe(false);
});
