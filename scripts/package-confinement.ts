// The external packages that only some files may import, and the ones no
// file may import at all. Every file of an owner package may import a
// confined package, and so may each file that `files` lists, in any package.
// A production file outside both never imports it; `inTests` confines it in
// test files and helpers too. app owns each package that its modules still
// import until they move to the package that owns it. The oxlint import
// rules are the one gate that reads this table.
export interface Confinement {
  readonly specifier: string;
  readonly owners: readonly string[];
  readonly files: readonly string[];
  readonly inTests: boolean;
}

export const PACKAGE_CONFINEMENT: readonly Confinement[] = [
  {
    specifier: 'bun-pty',
    owners: [],

    // the local provider spawns sessions in PTYs, the fake impd runs its
    // guests in real PTYs, as impd does, the TUI harness runs the real client
    // in one, as a terminal does, and the raw-mode reads of the stub composer
    // and the stub menu need a real terminal to run in
    files: [
      'packages/execution/local/src/local-pty-provider.ts',
      'packages/execution/imp/src/testing/create-stub-imp-port.ts',
      'packages/test-utils/src/start-tui-harness.ts',
      'packages/test-utils/src/create-stub-composer.test.ts',
      'packages/test-utils/src/run-stub-menu-claude.test.ts',
    ],
    inTests: true,
  },
  {
    specifier: '@zgeoff/imp-client',
    owners: [],
    files: ['packages/execution/imp/src/imp-client-port.ts'],
    inTests: true,
  },
  {
    specifier: '@anthropic-ai/claude-agent-sdk',
    owners: [],
    files: [
      'packages/harnesses/claude/src/headless/build-claude-query-options.ts',
      'packages/harnesses/claude/src/headless/render-sdk-message.ts',
      'packages/harnesses/claude/src/headless/start-claude-headless-run.ts',
    ],
    inTests: true,
  },

  // tests and e2e journeys open a state database to check what a run wrote
  { specifier: 'bun:sqlite', owners: ['store', 'app'], files: [], inTests: false },
  { specifier: 'kysely', owners: ['store', 'app'], files: [], inTests: false },
  { specifier: 'better-auth', owners: ['mcp', 'app'], files: [], inTests: false },
  { specifier: '@better-auth', owners: ['mcp', 'app'], files: [], inTests: false },

  // the Claude SDK's peer, and the lock library the Claude config lock is
  // checked against, which only that check imports
  { specifier: '@modelcontextprotocol/sdk', owners: [], files: [], inTests: true },
  {
    specifier: 'proper-lockfile',
    owners: [],
    files: ['packages/harnesses/claude/src/local-trust/with-claude-config-lock.test.ts'],
    inTests: true,
  },

  // atc runs on Bun alone: bun test, never vitest or jest, and bun <file>,
  // never ts-node. PTYs come from bun-pty, because node-pty delivers no data
  // events under Bun
  { specifier: 'vitest', owners: [], files: [], inTests: true },
  { specifier: 'jest', owners: [], files: [], inTests: true },
  { specifier: '@jest', owners: [], files: [], inTests: true },
  { specifier: 'ts-node', owners: [], files: [], inTests: true },
  { specifier: 'node-pty', owners: [], files: [], inTests: true },
];
