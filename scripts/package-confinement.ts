// The external packages that only an owner package's files and the listed
// `files` may import; `inTests` confines one in tests and helpers too. The
// oxlint import rules are the one gate that reads this table.
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

    // Sessions, the fake impd's guests and the TUI harness's client run in
    // real PTYs, and the stub composer's and stub menu's raw-mode reads need a
    // real terminal
    files: [
      'packages/execution/local/src/local-pty-provider.ts',
      'packages/execution/imp/src/testing/answer-stub-session.ts',
      'packages/execution/imp/src/testing/stub-imp.ts',
      'packages/execution/imp/src/testing/try-kill.ts',
      'packages/test-utils/src/start-tui-harness.ts',
      'packages/test-utils/src/create-stub-composer.test.ts',
      'packages/test-utils/src/run-stub-menu-claude.test.ts',
    ],
    inTests: true,
  },
  {
    specifier: '@impz/client',
    owners: [],

    // the real port calls impd through the client, and the contract types
    // the impd stand-in is checked against come from its declarations
    files: [
      'packages/execution/imp/src/imp-client-port.ts',
      'packages/execution/imp/src/impd-contract.ts',
    ],
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
