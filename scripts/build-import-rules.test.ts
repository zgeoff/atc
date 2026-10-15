import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { z } from 'zod';
import { IMPORT_RULES_FILE, buildImportRules, collectEntries } from './build-import-rules';

// A temp tree standing in for the repo root, whose oxlint config extends the
// repo's own, so each fixture is linted by the committed rules at the path it
// would have in the repo.
function setupTest() {
  const tmp = setupTempDir('import-rules-');

  return {
    dir: tmp.dir,
    oxlint: join(import.meta.dir, '..', 'node_modules', '.bin', 'oxlint'),
    config: { extends: [join(import.meta.dir, '..', '.oxlintrc.json')] },
  };
}

test('it keeps the committed rules file equal to what the generator builds', async () => {
  const committed: unknown = await Bun.file(join(import.meta.dir, '..', IMPORT_RULES_FILE)).json();

  const entries = collectEntries(join(import.meta.dir, '..'));

  expect(committed).toStrictEqual(buildImportRules(entries));
});

test('it reads the entry points of each package whose manifest exists', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts', './wire': './src/wire/index.ts' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  expect(collectEntries(ctx.dir)).toStrictEqual(
    new Map([
      ['@atc/core', ['.']],
      ['@atc/protocol', ['.', './wire']],
    ]),
  );
});

test.each([
  [
    'a package outside the row',
    'packages/core/src/a.ts',
    '@atc/protocol',
    '@atc/core may depend only on external packages.',
  ],
  [
    'a front end reaching the daemon',
    'packages/tui/src/a.ts',
    '@atc/daemon',
    '@atc/tui may depend only on @atc/core, @atc/protocol, @atc/config.',
  ],
  [
    'a test reaching a package outside the row',
    'packages/core/src/a.test.ts',
    '@atc/daemon/testing',
    '@atc/core may depend only on external packages.',
  ],
  [
    'a deep import into src',
    'packages/tui/src/a.ts',
    '@atc/core/src/ids',
    'Import a package through its entry points, never its src/ files.',
  ],
  [
    'a module that no entry point lists',
    'packages/tui/src/a.ts',
    '@atc/core/is-record',
    'Import a package through an entry point its exports map lists.',
  ],
  [
    'a module inside a named entry point',
    'packages/tui/src/a.ts',
    '@atc/protocol/wire/daemon-client',
    'Import a package through an entry point its exports map lists.',
  ],
  [
    'the bare name of a package whose exports map lists no root entry',
    'e2e/a.test.ts',
    '@atc/app',
    'Import a package through an entry point its exports map lists.',
  ],
  [
    'a module that no entry point lists, from e2e',
    'e2e/a.test.ts',
    '@atc/test-utils/wait-for',
    'Import a package through an entry point its exports map lists.',
  ],
  [
    'a node: module in core',
    'packages/core/src/a.ts',
    'node:fs',
    '@atc/core runs on any runtime: it imports no node: or bun: module.',
  ],
  [
    'a bun: module in core',
    'packages/core/src/a.ts',
    'bun:ffi',
    '@atc/core runs on any runtime: it imports no node: or bun: module.',
  ],
  [
    'the shared test helpers',
    'packages/protocol/src/a.ts',
    '@atc/test-utils',
    'Production code never imports the shared test helpers.',
  ],
  [
    'a module of the shared test helpers',
    'packages/protocol/src/a.ts',
    '@atc/test-utils/wait-for',
    'Production code never imports the shared test helpers.',
  ],
  [
    'a testing entry',
    'packages/protocol/src/a.ts',
    '@atc/core/testing',
    'Production code never imports a testing entry or a testing/ folder.',
  ],
  [
    'a module under a testing entry',
    'packages/protocol/src/a.ts',
    '@atc/core/testing/fake-clock',
    'Production code never imports a testing entry or a testing/ folder.',
  ],
  [
    'a relative testing folder',
    'packages/protocol/src/a.ts',
    './testing/fake-clock',
    'Production code never imports a testing entry or a testing/ folder.',
  ],
  [
    'the daemon itself in a front-end test',
    'packages/tui/src/a.test.ts',
    '@atc/daemon',
    'A test in @atc/tui may use @atc/daemon/testing, never the daemon itself.',
  ],
  [
    'bun-pty outside its files',
    'packages/daemon/src/a.ts',
    'bun-pty',
    'bun-pty belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'bun-pty in a file of the local provider package that the table does not list',
    'packages/execution/local/src/a.ts',
    'bun-pty',
    'bun-pty belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'bun-pty in a test helper that the table does not list',
    'packages/test-utils/src/start-stub-terminal.ts',
    'bun-pty',
    'bun-pty belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'bun-pty in the app',
    'packages/app/src/a.ts',
    'bun-pty',
    'bun-pty belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'the shared test helpers in a production file the table lists',
    'packages/execution/local/src/local-pty-provider.ts',
    '@atc/test-utils',
    'Production code never imports the shared test helpers.',
  ],
  [
    'the imp client outside its file',
    'packages/execution/imp/src/a.ts',
    '@zgeoff/imp-client',
    '@zgeoff/imp-client belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'the imp client in an e2e journey',
    'e2e/a.test.ts',
    '@zgeoff/imp-client',
    '@zgeoff/imp-client belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'the imp client in a script module',
    'scripts/a.mjs',
    '@zgeoff/imp-client',
    '@zgeoff/imp-client belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'the Claude SDK outside its files',
    'packages/harnesses/claude/src/a.ts',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'bun:sqlite outside its owner',
    'packages/daemon/src/a.ts',
    'bun:sqlite',
    'bun:sqlite belongs to @atc/store, @atc/app.',
  ],
  [
    'kysely outside its owner',
    'packages/mcp/src/a.ts',
    'kysely',
    'kysely belongs to @atc/store, @atc/app.',
  ],
  [
    'better-auth outside its owner',
    'packages/daemon/src/a.ts',
    'better-auth',
    'better-auth belongs to @atc/mcp, @atc/app.',
  ],
  [
    'a better-auth plugin outside its owner',
    'packages/daemon/src/a.ts',
    '@better-auth/mcp',
    '@better-auth belongs to @atc/mcp, @atc/app.',
  ],
  [
    'the MCP SDK v1 anywhere',
    'packages/app/src/a.ts',
    '@modelcontextprotocol/sdk/server',
    'No file imports @modelcontextprotocol/sdk.',
  ],
  [
    'proper-lockfile in the Claude config lock itself',
    'packages/harnesses/claude/src/local-trust/with-claude-config-lock.ts',
    'proper-lockfile',
    'proper-lockfile belongs to the files that scripts/package-confinement.ts lists.',
  ],
  [
    'proper-lockfile in an e2e journey',
    'e2e/a.test.ts',
    'proper-lockfile',
    'proper-lockfile belongs to the files that scripts/package-confinement.ts lists.',
  ],
])('it refuses %s', async (_label, file, specifier, help) => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.dir, file),
    `import { a } from '${specifier}';\n\nexport const VALUE = [a];\n`,
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', file],
    {
      cwd: ctx.dir,
    },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'eslint(no-restricted-imports)',
    filename: file,
    help,
  });
});

test.each([
  ['a package in the row', 'packages/tui/src/a.ts', '@atc/protocol'],
  ['a named entry point', 'packages/tui/src/a.ts', '@atc/protocol/wire'],
  ['a named entry point from e2e', 'e2e/a.test.ts', '@atc/store/sqlite'],
  [
    'the daemon testing entry in a front-end test',
    'packages/tui/src/a.test.ts',
    '@atc/daemon/testing',
  ],
  ['the shared test helpers in a test', 'packages/store/src/a.test.ts', '@atc/test-utils'],
  ['a testing entry in a testing folder', 'packages/store/src/testing/a.ts', '@atc/store/testing'],
  ['bun:test in a core test', 'packages/core/src/a.test.ts', 'bun:test'],
  ['kysely in its owner', 'packages/store/src/a.ts', 'kysely'],
  ['bun-pty in a listed test helper', 'packages/test-utils/src/start-tui-harness.ts', 'bun-pty'],
  [
    'bun-pty in the local provider',
    'packages/execution/local/src/local-pty-provider.ts',
    'bun-pty',
  ],
  [
    'the Claude SDK in a listed file',
    'packages/harnesses/claude/src/headless/render-sdk-message.ts',
    '@anthropic-ai/claude-agent-sdk',
  ],
  [
    'proper-lockfile in the Claude config lock test',
    'packages/harnesses/claude/src/local-trust/with-claude-config-lock.test.ts',
    'proper-lockfile',
  ],
  ['bun:sqlite in an e2e journey', 'e2e/a.test.ts', 'bun:sqlite'],
  ['a confined package in the app that still owns it', 'packages/app/src/a.ts', 'kysely'],
])('it allows %s', async (_label, file, specifier) => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.dir, file),
    `import { a } from '${specifier}';\n\nexport const VALUE = [a];\n`,
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', file],
    {
      cwd: ctx.dir,
    },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).not.toPartiallyContain({ code: 'eslint(no-restricted-imports)' });
});

test('it keeps the synchronous spawn ban in a package override', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.dir, 'packages/store/src/a.ts'),
    "import { spawnSync } from 'node:child_process';\n\nexport const VALUE = [spawnSync];\n",
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', 'packages/store/src/a.ts'],
    { cwd: ctx.dir },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'eslint(no-restricted-imports)',
    help: "Use an async spawn: Bun runs these through its synchronous spawn, which can lose a child's exit and hang (oven-sh/bun#34069).",
  });
});

test('it refuses a confined package in a mod, which only the mods config lints', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(import.meta.dir, '..', '.oxlintrc.mods.json')] }),
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/hooks/register.ts'),
    "import { ImpClient } from '@zgeoff/imp-client';\n\nexport const VALUE = [ImpClient];\n",
  );

  const linted = await runCommand(
    [
      process.execPath,
      ctx.oxlint,
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'mods/bridge/hooks/register.ts',
    ],
    { cwd: ctx.dir },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toHaveLength(1);

  expect(report.diagnostics).toPartiallyContain({
    code: 'eslint(no-restricted-imports)',
    filename: 'mods/bridge/hooks/register.ts',
    help: '@zgeoff/imp-client belongs to the files that scripts/package-confinement.ts lists.',
  });
});

test('it refuses a require call in a mod', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(import.meta.dir, '..', '.oxlintrc.mods.json')] }),
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/hooks/register.ts'),
    "export const PTY: unknown = require('bun-pty');\n",
  );

  const linted = await runCommand(
    [
      process.execPath,
      ctx.oxlint,
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'mods/bridge/hooks/register.ts',
    ],
    { cwd: ctx.dir },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toHaveLength(1);

  expect(report.diagnostics).toPartiallyContain({
    code: 'typescript(no-require-imports)',
    filename: 'mods/bridge/hooks/register.ts',
  });
});

test('it refuses an import() type annotation in a mod', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(import.meta.dir, '..', '.oxlintrc.mods.json')] }),
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/hooks/register.ts'),
    "export type Client = import('@zgeoff/imp-client').ImpClient;\n",
  );

  const linted = await runCommand(
    [
      process.execPath,
      ctx.oxlint,
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'mods/bridge/hooks/register.ts',
    ],
    { cwd: ctx.dir },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toHaveLength(1);

  expect(report.diagnostics).toPartiallyContain({
    code: 'typescript(consistent-type-imports)',
    filename: 'mods/bridge/hooks/register.ts',
  });
});

test('it refuses a require call, whose specifier the import rules do not read', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/a.ts'),
    "export const PTY: unknown = require('bun-pty');\n",
  );

  const linted = await runCommand(
    [
      process.execPath,
      ctx.oxlint,
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'packages/daemon/src/a.ts',
    ],
    { cwd: ctx.dir },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'typescript(no-require-imports)',
    filename: 'packages/daemon/src/a.ts',
  });
});
