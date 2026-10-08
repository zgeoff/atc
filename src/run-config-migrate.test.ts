import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runConfigMigrate } from './run-config-migrate';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory for the config file under migration. The directory goes
 * once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-config-migrate-');

  return { dir: tmp.dir };
}

test('it prints the migrated config and leaves the file alone without --write', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ claudeBin: '/opt/claude', leader: 'ctrl-a' });

  writeFileSync(file, original);

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, false, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
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

test('it backs the file up, rewrites it, and prints both paths with --write', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ codexBin: '/opt/codex' });

  writeFileSync(file, original);

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, true, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  const [backupName, ...others] = readdirSync(ctx.dir).filter((name) => name !== 'config.json');

  invariant(backupName !== undefined, 'the migration wrote no backup');

  const backup = join(ctx.dir, backupName);

  expect(backupName).toMatch(/^config\.json\.bak-\d{8}T\d{6}Z$/u);

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: `backup: ${backup}\nwrote: ${file}\n`,
    stderr: '',
    code: 0,
  });

  expect(others).toStrictEqual([]);
  expect(readFileSync(backup, 'utf8')).toBe(original);

  expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toStrictEqual({
    agents: { claude: {}, grok: {}, codex: { bin: '/opt/codex' } },
  });
});

test('it says nothing to migrate and writes nothing for a file that uses agents', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, JSON.stringify({ agents: { claude: {} } }));

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, true, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: 'config.json already uses agents; nothing to migrate\n',
    stderr: '',
    code: 0,
  });

  expect(readdirSync(ctx.dir)).toStrictEqual(['config.json']);
});

test('it exits 1 and writes nothing for a file that sets agents beside an old key', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');
  const original = JSON.stringify({ agents: {}, claudeBin: 'x' });

  writeFileSync(file, original);

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, true, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file}: claudeBin cannot be set together with agents; move them into agents or run 'atc config migrate'\n`,
    code: 1,
  });

  expect(readdirSync(ctx.dir)).toStrictEqual(['config.json']);
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('it notes each dropped gateway on stderr without printing a value', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(
    file,
    JSON.stringify({ gateways: { broken: { env: { TOKEN: 'sk-secret-value' } } } }),
  );

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, false, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: `${JSON.stringify({ agents: { claude: {}, grok: {}, codex: {} } }, null, 2)}\n`,
    stderr: 'atc config migrate: gateways.broken is left out: it has no baseURL\n',
    code: 0,
  });
});

test('it exits 1 for a file that is not valid JSON', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, '{ "claudeBin": ');

  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, false, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} is not valid JSON\n`,
    code: 1,
  });
});

test('it exits 1 for a file that does not exist', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');
  let stdout = '';
  let stderr = '';

  const code = runConfigMigrate(file, false, {
    printText: (text) => {
      stdout += text;
    },
    print: (line) => {
      stdout += `${line}\n`;
    },
    printError: (line) => {
      stderr += `${line}\n`;
    },
  });

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} cannot be read\n`,
    code: 1,
  });

  expect(existsSync(file)).toBe(false);
});
