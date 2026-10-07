import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runConfigMigrate } from './run-config-migrate';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory for the config file under migration. Disposal removes the
 * directory.
 */
function setupTest() {
  return setupTempDir('atc-config-migrate-');
}

test('it prints the migrated config and leaves the file alone without --write', () => {
  using ctx = setupTest();

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

test('it backs the file up, rewrites it, and prints both paths with --write', () => {
  using ctx = setupTest();

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

test('it says nothing to migrate and writes nothing for a file that uses agents', () => {
  using ctx = setupTest();

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

  expect({ stdout, stderr, code, entries: readdirSync(ctx.dir) }).toStrictEqual({
    stdout: 'config.json already uses agents; nothing to migrate\n',
    stderr: '',
    code: 0,
    entries: ['config.json'],
  });
});

test('it exits 1 and writes nothing for a file that sets agents beside an old key', () => {
  using ctx = setupTest();

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

test('it notes each dropped gateway on stderr without printing a value', () => {
  using ctx = setupTest();

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
  using ctx = setupTest();

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
  using ctx = setupTest();

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

  expect({ stdout, stderr, code, created: existsSync(file) }).toStrictEqual({
    stdout: '',
    stderr: `atc config migrate: ${file} cannot be read\n`,
    code: 1,
    created: false,
  });
});
