import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { z } from 'zod';

// A temp tree standing in for the repo root, linted by the committed config
// at the path each fixture would have in the repo
async function setupTest() {
  const temporaryDirectory = setupTempDir('import-zones-');
  const root = join(import.meta.dir, '..');

  // the zones resolve from the nearest .git, and each package name through its manifest
  mkdirSync(join(temporaryDirectory.path, '.git'));

  const manifests = [
    ...new Bun.Glob('packages/*/package.json').scanSync(root),
    ...new Bun.Glob('packages/*/*/package.json').scanSync(root),
  ];

  await Promise.all(
    manifests.map((manifest) =>
      Bun.write(join(temporaryDirectory.path, manifest), Bun.file(join(root, manifest))),
    ),
  );

  return {
    directory: temporaryDirectory.path,
    oxlint: join(root, 'node_modules', '.bin', 'oxlint'),
    config: { extends: [join(root, '.oxlintrc.json')] },
    modsConfig: { extends: [join(root, '.oxlintrc.mods.json')] },
  };
}

test.each([
  [
    'a package outside the row',
    'packages/core/src/a.ts',
    '@atc/protocol',
    [],
    'package-deps: core must not import packages/protocol (packages, protocol) — @atc/core depends on no workspace package',
  ],
  [
    'a front end reaching the daemon',
    'packages/tui/src/a.ts',
    '@atc/daemon',
    [],
    'package-deps: front-ends must not import packages/daemon (packages, daemon)',
  ],
  [
    'a test reaching a package outside the row',
    'packages/core/src/a.test.ts',
    '@atc/daemon/testing',
    [],
    'package-deps: core must not import packages/daemon/testing (packages, daemon, daemon-testing, testing) — @atc/core depends on no workspace package',
  ],
  [
    'a deep import into src',
    'packages/tui/src/a.ts',
    '@atc/core/src/ids',
    [],
    'entry-points: cannot resolve @atc/core/src/ids',
  ],
  [
    'a module that no entry point lists',
    'packages/tui/src/a.ts',
    '@atc/core/is-record',
    [],
    'entry-points: cannot resolve @atc/core/is-record',
  ],
  [
    'a module inside a named entry point',
    'packages/tui/src/a.ts',
    '@atc/protocol/wire/daemon-client',
    [],
    'entry-points: cannot resolve @atc/protocol/wire/daemon-client',
  ],
  [
    'the bare name of a package whose exports map lists no root entry',
    'e2e/a.test.ts',
    '@atc/app',
    [],
    'entry-points: cannot resolve @atc/app',
  ],
  [
    'a module that no entry point lists, from e2e',
    'e2e/a.test.ts',
    '@atc/test-utils/wait-for',
    [],
    'entry-points: cannot resolve @atc/test-utils/wait-for',
  ],
  [
    'a node: module in core',
    'packages/core/src/a.ts',
    'node:fs',
    [],
    'any-runtime: node:fs is allowed only in no zone — @atc/core runs on any runtime',
  ],
  [
    'a bun: module in core',
    'packages/core/src/a.ts',
    'bun:ffi',
    [],
    'any-runtime: bun:ffi is allowed only in no zone — @atc/core runs on any runtime',
  ],
  [
    'the shared test helpers',
    'packages/protocol/src/a.ts',
    '@atc/test-utils',
    [],
    'test-helpers: packages must not import packages/test-utils (packages, test-utils) — production code never imports the shared test helpers',
  ],
  [
    'a module of the shared test helpers',
    'packages/protocol/src/a.ts',
    '@atc/test-utils/wait-for',
    [],
    'entry-points: cannot resolve @atc/test-utils/wait-for',
  ],
  [
    'a module of the shared test helpers by path',
    'packages/protocol/src/a.ts',
    '../../test-utils/src/wait-for',
    ['packages/test-utils/src/wait-for.ts'],
    'test-helpers: packages must not import packages/test-utils/src/wait-for.ts (packages, test-utils, tests) — production code never imports the shared test helpers',
  ],
  [
    'a testing entry',
    'packages/protocol/src/a.ts',
    '@atc/core/testing',
    [],
    'entry-points: cannot resolve @atc/core/testing',
  ],
  [
    'a testing entry that the exports map lists',
    'packages/protocol/src/a.ts',
    '@atc/store/testing',
    [],
    'testing-entries: packages must not import packages/store/testing (packages, store, testing) — production code never imports a testing entry or a testing/ folder',
  ],
  [
    'a module under a testing entry',
    'packages/protocol/src/a.ts',
    '@atc/core/testing/fake-clock',
    [],
    'entry-points: cannot resolve @atc/core/testing/fake-clock',
  ],
  [
    'a relative testing folder',
    'packages/protocol/src/a.ts',
    './testing/fake-clock',
    ['packages/protocol/src/testing/fake-clock.ts'],
    'testing-entries: packages must not import packages/protocol/src/testing/fake-clock.ts (packages, protocol, testing, tests) — production code never imports a testing entry or a testing/ folder',
  ],
  [
    'the daemon itself in a front-end test',
    'packages/tui/src/a.test.ts',
    '@atc/daemon',
    [],
    'package-deps: front-ends must not import packages/daemon (packages, daemon)',
  ],
  [
    'bun-pty outside its files',
    'packages/daemon/src/a.ts',
    'bun-pty',
    [],
    'confinement: bun-pty is allowed only in pty-files',
  ],
  [
    'bun-pty in a file of the local provider package that the table does not list',
    'packages/execution/local/src/a.ts',
    'bun-pty',
    [],
    'confinement: bun-pty is allowed only in pty-files',
  ],
  [
    'bun-pty in a test helper that the table does not list',
    'packages/test-utils/src/start-stub-terminal.ts',
    'bun-pty',
    [],
    'confinement: bun-pty is allowed only in pty-files',
  ],
  [
    'bun-pty in the app',
    'packages/app/src/a.ts',
    'bun-pty',
    [],
    'confinement: bun-pty is allowed only in pty-files',
  ],
  [
    'the shared test helpers in a production file the table lists',
    'packages/execution/local/src/local-pty-provider.ts',
    '@atc/test-utils',
    [],
    'test-helpers: packages must not import packages/test-utils (packages, test-utils) — production code never imports the shared test helpers',
  ],
  [
    'the imp client outside its file',
    'packages/execution/imp/src/a.ts',
    '@impz/client',
    [],
    'confinement: @impz/client is allowed only in imp-client-files',
  ],
  [
    'the imp client in an e2e journey',
    'e2e/a.test.ts',
    '@impz/client',
    [],
    'confinement: @impz/client is allowed only in imp-client-files',
  ],
  [
    'the imp client in a script module',
    'scripts/a.mjs',
    '@impz/client',
    [],
    'confinement: @impz/client is allowed only in imp-client-files',
  ],
  [
    'the Claude SDK outside its files',
    'packages/harnesses/claude/src/a.ts',
    '@anthropic-ai/claude-agent-sdk',
    [],
    'confinement: @anthropic-ai/claude-agent-sdk is allowed only in claude-sdk-files',
  ],
  [
    'bun:sqlite outside its owner',
    'packages/daemon/src/a.ts',
    'bun:sqlite',
    [],
    'confinement: bun:sqlite is allowed only in store, app, tests',
  ],
  [
    'kysely outside its owner',
    'packages/daemon/src/a.ts',
    'kysely',
    [],
    'confinement: kysely is allowed only in store, mcp, app, tests',
  ],
  [
    'better-auth outside its owner',
    'packages/daemon/src/a.ts',
    'better-auth',
    [],
    'confinement: better-auth is allowed only in mcp, tests',
  ],
  [
    'a better-auth plugin outside its owner',
    'packages/daemon/src/a.ts',
    '@better-auth/mcp',
    [],
    'confinement: @better-auth/mcp is allowed only in mcp, tests',
  ],
  [
    'the MCP SDK v1 anywhere',
    'packages/app/src/a.ts',
    '@modelcontextprotocol/sdk/server',
    [],
    'confinement: @modelcontextprotocol/sdk/server is allowed only in no zone',
  ],
  [
    'proper-lockfile in the Claude config lock itself',
    'packages/harnesses/claude/src/local-trust/with-claude-config-lock.ts',
    'proper-lockfile',
    [],
    'confinement: proper-lockfile is allowed only in config-lock-check',
  ],
  [
    'proper-lockfile in an e2e journey',
    'e2e/a.test.ts',
    'proper-lockfile',
    [],
    'confinement: proper-lockfile is allowed only in config-lock-check',
  ],
  [
    'vitest in a test',
    'packages/core/src/a.test.ts',
    'vitest',
    [],
    'bun-only: vitest is allowed only in no zone',
  ],
  [
    'jest in an e2e journey',
    'e2e/a.test.ts',
    'jest',
    [],
    'bun-only: jest is allowed only in no zone',
  ],
  [
    'the jest globals in a test helper',
    'packages/test-utils/src/a.ts',
    '@jest/globals',
    [],
    'bun-only: @jest/globals is allowed only in no zone',
  ],
  [
    'ts-node in a script',
    'scripts/a.ts',
    'ts-node/register',
    [],
    'bun-only: ts-node/register is allowed only in no zone',
  ],
  [
    'node-pty in the local provider',
    'packages/execution/local/src/local-pty-provider.ts',
    'node-pty',
    [],
    'bun-only: node-pty is allowed only in no zone',
  ],
  [
    'its own package by name in core',
    'packages/core/src/a.ts',
    '@atc/core',
    [],
    'self-import: @atc/core names the package this file belongs to; import it by a relative path — a module reaches its own package by a relative path',
  ],
  [
    'its own testing entry by name in a test',
    'packages/store/src/testing/a.ts',
    '@atc/store/testing',
    [],
    'self-import: @atc/store/testing names the package this file belongs to; import it by a relative path — a module reaches its own package by a relative path',
  ],
  [
    'its own package by name in the shared test helpers',
    'packages/test-utils/src/a.ts',
    '@atc/test-utils',
    [],
    'self-import: @atc/test-utils names the package this file belongs to; import it by a relative path — a module reaches its own package by a relative path',
  ],
  [
    'its own package by name in a daemon folder',
    'packages/daemon/src/fleet/a.ts',
    '@atc/daemon/testing',
    [],
    'self-import: @atc/daemon/testing names the package this file belongs to; import it by a relative path — a module reaches its own package by a relative path',
  ],
  [
    'its own package by name in a file a confinement lists',
    'packages/execution/local/src/local-pty-provider.ts',
    '@atc/execution-local',
    [],
    'self-import: @atc/execution-local names the package this file belongs to; import it by a relative path — a module reaches its own package by a relative path',
  ],
  [
    'a daemon folder its folder rule leaves out',
    'packages/daemon/src/fleet/a.ts',
    '../transport/start-tcp-listener',
    ['packages/daemon/src/transport/start-tcp-listener.ts'],
    'daemon-folders: daemon-fleet must not import packages/daemon/src/transport/start-tcp-listener.ts (packages, daemon, daemon-transport) — the fleet folder imports only the sessions folder',
  ],
  [
    'a root file of the daemon from a folder its rule keeps from the root',
    'packages/daemon/src/workspace/a.ts',
    '../daemon-context',
    ['packages/daemon/src/daemon-context.ts'],
    'daemon-folders: daemon-workspace must not import packages/daemon/src/daemon-context.ts (packages, daemon, daemon-root) — the workspace folder imports only its own modules',
  ],
  [
    'a package outside the row in a daemon folder',
    'packages/daemon/src/sessions/a.ts',
    '@atc/execution-local',
    [],
    'package-deps: daemon must not import packages/execution/local (packages, plugins)',
  ],
])('it refuses %s', async (_label, file, specifier, targets, message) => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.directory, '.oxlintrc.json'), JSON.stringify(ctx.config));

  for (const target of targets) {
    await Bun.write(join(ctx.directory, target), 'export const a = 1;\n');
  }

  await Bun.write(
    join(ctx.directory, file),
    `import { a } from '${specifier}';\n\nexport const VALUE = [a];\n`,
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', file],
    { cwd: ctx.directory },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'zgeoff(import-zones)',
    filename: file,
    message,
  });
});

test('it refuses a file in a workspace package outside every package zone', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.directory, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.directory, 'packages/extras/package.json'),
    JSON.stringify({ name: '@atc/extras', exports: { '.': './src/a.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/extras/src/a.ts'),
    "import { a } from '@atc/core';\n\nexport const VALUE = [a];\n",
  );

  const linted = await runCommand(
    [
      process.execPath,
      ctx.oxlint,
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'packages/extras/src/a.ts',
    ],
    { cwd: ctx.directory },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(linted.exitCode).toBe(1);

  expect(report.diagnostics).toPartiallyContain({
    code: 'zgeoff(import-zones)',
    filename: 'packages/extras/src/a.ts',
    message:
      'package-zones: this file belongs to none of core, protocol, plugin-api, config, store, lifecycle, daemon, plugins, front-ends, test-utils, app; add its path to one',
  });
});

test.each([
  ['a package in the row', 'packages/tui/src/a.ts', '@atc/protocol', []],
  ['a named entry point', 'packages/tui/src/a.ts', '@atc/protocol/wire', []],
  ['a named entry point from e2e', 'e2e/a.test.ts', '@atc/store/sqlite', []],
  [
    'the daemon testing entry in a front-end test',
    'packages/tui/src/a.test.ts',
    '@atc/daemon/testing',
    [],
  ],
  ['the shared test helpers in a test', 'packages/store/src/a.test.ts', '@atc/test-utils', []],
  [
    'a testing entry in a testing folder',
    'packages/lifecycle/src/testing/a.ts',
    '@atc/store/testing',
    [],
  ],
  ['bun:test in a core test', 'packages/core/src/a.test.ts', 'bun:test', []],
  ['kysely in its owner', 'packages/store/src/a.ts', 'kysely', []],
  [
    'bun-pty in a listed test helper',
    'packages/test-utils/src/start-tui-harness.ts',
    'bun-pty',
    [],
  ],
  [
    'bun-pty in the local provider',
    'packages/execution/local/src/local-pty-provider.ts',
    'bun-pty',
    [],
  ],
  [
    'the Claude SDK in a listed file',
    'packages/harnesses/claude/src/headless/render-sdk-message.ts',
    '@anthropic-ai/claude-agent-sdk',
    [],
  ],
  [
    'proper-lockfile in the Claude config lock test',
    'packages/harnesses/claude/src/local-trust/with-claude-config-lock.test.ts',
    'proper-lockfile',
    [],
  ],
  ['bun:sqlite in an e2e journey', 'e2e/a.test.ts', 'bun:sqlite', []],
  ['a confined package in the app that owns it', 'packages/app/src/a.ts', 'kysely', []],
  [
    'a daemon folder its folder rule lists',
    'packages/daemon/src/fleet/a.ts',
    '../sessions/session',
    ['packages/daemon/src/sessions/session.ts'],
  ],
  [
    'a module of the same daemon folder',
    'packages/daemon/src/workspace/a.ts',
    './run-host-git',
    ['packages/daemon/src/workspace/run-host-git.ts'],
  ],
  [
    'a root file of the daemon from a folder',
    'packages/daemon/src/sessions/a.ts',
    '../daemon-context',
    ['packages/daemon/src/daemon-context.ts'],
  ],
  [
    'a daemon folder its folder rule leaves out, in a test',
    'packages/daemon/src/fleet/a.test.ts',
    '../transport/start-tcp-listener',
    ['packages/daemon/src/transport/start-tcp-listener.ts'],
  ],
])('it allows %s', async (_label, file, specifier, targets) => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.directory, '.oxlintrc.json'), JSON.stringify(ctx.config));

  for (const target of targets) {
    await Bun.write(join(ctx.directory, target), 'export const a = 1;\n');
  }

  await Bun.write(
    join(ctx.directory, file),
    `import { a } from '${specifier}';\n\nexport const VALUE = [a];\n`,
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', file],
    { cwd: ctx.directory },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).not.toPartiallyContain({ code: 'zgeoff(import-zones)' });
});

test('it refuses a synchronous spawn in a package', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.directory, '.oxlintrc.json'), JSON.stringify(ctx.config));

  await Bun.write(
    join(ctx.directory, 'packages/store/src/a.ts'),
    "import { spawnSync } from 'node:child_process';\n\nexport const VALUE = [spawnSync];\n",
  );

  const linted = await runCommand(
    [process.execPath, ctx.oxlint, '-c', '.oxlintrc.json', '-f', 'json', 'packages/store/src/a.ts'],
    { cwd: ctx.directory },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'eslint(no-restricted-imports)',
    help: "Use an async spawn: Bun runs these through its synchronous spawn, which can lose a child's exit and hang (oven-sh/bun#34069).",
  });
});

test.each([
  [
    'a confined package',
    "import { ImpClient } from '@impz/client';\n\nexport const VALUE = [ImpClient];\n",
    'confinement: @impz/client is allowed only in imp-client-files',
  ],
  [
    'node-pty',
    "import { spawn } from 'node-pty';\n\nexport const VALUE = [spawn];\n",
    'bun-only: node-pty is allowed only in no zone',
  ],
  [
    'a confined package in a require call',
    "export const PTY: unknown = require('bun-pty');\n",
    'confinement: bun-pty is allowed only in pty-files',
  ],
  [
    'a confined package in an import() type annotation',
    "export type Client = import('@impz/client').ImpClient;\n",
    'confinement: @impz/client is allowed only in imp-client-files',
  ],
])('it refuses %s in a mod, which only the mods config lints', async (_label, source, message) => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.directory, '.oxlintrc.json'), JSON.stringify(ctx.modsConfig));
  await Bun.write(join(ctx.directory, 'mods/bridge/hooks/register.ts'), source);

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
    { cwd: ctx.directory },
  );

  const report = z
    .object({ diagnostics: z.array(z.looseObject({})) })
    .parse(JSON.parse(linted.stdout));

  expect(report.diagnostics).toPartiallyContain({
    code: 'zgeoff(import-zones)',
    filename: 'mods/bridge/hooks/register.ts',
    message,
  });
});
