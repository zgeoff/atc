import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../packages/app/src/test-utils/run-command';
import { setupTempDir } from '../packages/app/src/test-utils/setup-temp-dir';
import { IMPORT_RULES_FILE, buildImportRules } from './build-import-rules';

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

  expect(committed).toStrictEqual(buildImportRules());
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
    'bun-pty outside its owner',
    'packages/daemon/src/a.ts',
    'bun-pty',
    'bun-pty belongs to @atc/execution-local, @atc/app.',
  ],
  [
    'bun-pty in a test helper that is no exception',
    'packages/test-utils/src/start-stub-terminal.ts',
    'bun-pty',
    'bun-pty belongs to @atc/execution-local, @atc/app.',
  ],
  [
    'the imp client outside its owner',
    'packages/daemon/src/a.ts',
    '@zgeoff/imp-client',
    '@zgeoff/imp-client belongs to @atc/execution-imp, @atc/app.',
  ],
  [
    'the Claude SDK outside its owner',
    'packages/daemon/src/a.ts',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk belongs to @atc/harness-claude, @atc/app.',
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
    'proper-lockfile in an e2e journey',
    'e2e/a.test.ts',
    'proper-lockfile',
    'No file imports proper-lockfile.',
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
  [
    'the daemon testing entry in a front-end test',
    'packages/tui/src/a.test.ts',
    '@atc/daemon/testing',
  ],
  ['the shared test helpers in a test', 'packages/store/src/a.test.ts', '@atc/test-utils'],
  ['a testing entry in a testing folder', 'packages/store/src/testing/a.ts', '@atc/core/testing'],
  ['bun:test in a core test', 'packages/core/src/a.test.ts', 'bun:test'],
  ['kysely in its owner', 'packages/store/src/a.ts', 'kysely'],
  ['bun-pty in a listed exception', 'packages/test-utils/src/start-tui-harness.ts', 'bun-pty'],
  ['bun:sqlite in an e2e journey', 'e2e/a.test.ts', 'bun:sqlite'],
  ['a confined package in the app that still owns it', 'packages/app/src/a.ts', 'bun-pty'],
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
