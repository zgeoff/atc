import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveATCCommand, runATC, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-config-migrate-');

  return { directory: temporaryDirectory.path };
}

test('it backs the file up, rewrites it, and prints both paths with --write', async () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'config.json');
  const original = JSON.stringify({ codexBin: '/opt/codex' });

  writeFileSync(file, original);

  const migrated = await runATC({
    command: resolveATCCommand(),
    args: ['config', 'migrate', '--file', file, '--write'],
    home: ctx.directory,
  });

  const [backupName, ...others] = readdirSync(ctx.directory).filter(
    (name) => name !== 'config.json',
  );

  invariant(backupName !== undefined, 'the migration wrote no backup');

  const backup = join(ctx.directory, backupName);

  expect(backupName).toMatch(/^config\.json\.bak-\d{8}T\d{6}Z$/u);

  expect({
    stdout: migrated.stdout,
    stderr: migrated.stderr,
    code: migrated.exitCode,
  }).toStrictEqual({
    stdout: `backup: ${backup}\nwrote: ${file}\n`,
    stderr: '',
    code: 0,
  });

  expect(others).toStrictEqual([]);
  expect(readFileSync(backup, 'utf8')).toBe(original);

  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
    agents: { claude: {}, grok: {}, codex: { bin: '/opt/codex' } },
  });
});

test('it moves dirs, workspaces.githubOwner and workspaces.sources into sources with --write', async () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'config.json');

  writeFileSync(
    file,
    JSON.stringify({
      agents: { claude: {} },
      dirs: { roots: ['~/code'] },
      workspaces: { githubOwner: 'acme-tools', sources: null },
    }),
  );

  const migrated = await runATC({
    command: resolveATCCommand(),
    args: ['config', 'migrate', '--file', file, '--write'],
    home: ctx.directory,
  });

  expect({ stderr: migrated.stderr, code: migrated.exitCode }).toStrictEqual({
    stderr: '',
    code: 0,
  });

  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
    agents: { claude: {} },
    sources: { dirs: { roots: ['~/code'] }, github: { owner: 'acme-tools' }, git: {} },
  });
});

test.each([
  [
    'workspaces.githubOwner',
    {
      sources: { github: { owner: 'north-labs' } },
      workspaces: { githubOwner: 'south-labs' },
    },
  ],
  ['dirs', { sources: {}, dirs: { roots: ['~/code'] } }],
])(
  'it exits 1 and leaves the file unchanged when sources sits beside the old key %s',
  async (key, config) => {
    const ctx = setupTest();
    const file = join(ctx.directory, 'config.json');
    const original = JSON.stringify({ agents: { claude: {} }, ...config });

    writeFileSync(file, original);

    const migrated = await runATC({
      command: resolveATCCommand(),
      args: ['config', 'migrate', '--file', file, '--write'],
      home: ctx.directory,
    });

    expect({
      stdout: migrated.stdout,
      stderr: migrated.stderr,
      code: migrated.exitCode,
    }).toStrictEqual({
      stdout: '',
      stderr: `atc config migrate: ${file}: ${key} cannot be set together with sources; move it into sources and remove it\n`,
      code: 1,
    });

    expect({
      text: readFileSync(file, 'utf8'),
      files: readdirSync(ctx.directory),
    }).toStrictEqual({ text: original, files: ['config.json'] });
  },
);
