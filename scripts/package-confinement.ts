// The external packages that belong to one workspace package, and the ones no
// file may import at all. A production file outside the owners never imports
// a confined package; `inTests` confines it in test files and helpers too.
// `exceptions` lists the files outside the owners that may still import it.
// app owns each package that its modules still import until they move to the
// package that owns it.
export interface Confinement {
  readonly specifier: string;
  readonly owners: readonly string[];
  readonly inTests: boolean;
  readonly exceptions: readonly string[];
}

export const PACKAGE_CONFINEMENT: readonly Confinement[] = [
  {
    specifier: 'bun-pty',
    owners: ['execution-local', 'app'],
    inTests: true,

    // the fake impd runs its guests in real PTYs, as impd does, the TUI
    // harness runs the real client in one, as a terminal does, and the stub
    // composer's raw-mode reads need a real terminal to run in
    exceptions: [
      'packages/execution/imp/src/testing/create-stub-imp-port.ts',
      'packages/test-utils/src/start-tui-harness.ts',
      'packages/test-utils/src/create-stub-composer.test.ts',
    ],
  },
  {
    specifier: '@zgeoff/imp-client',
    owners: ['execution-imp', 'app'],
    inTests: true,
    exceptions: [],
  },
  {
    specifier: '@anthropic-ai/claude-agent-sdk',
    owners: ['harness-claude', 'app'],
    inTests: true,
    exceptions: [],
  },

  // tests and e2e journeys open a state database to check what a run wrote
  { specifier: 'bun:sqlite', owners: ['store', 'app'], inTests: false, exceptions: [] },
  { specifier: 'kysely', owners: ['store', 'app'], inTests: false, exceptions: [] },
  { specifier: 'better-auth', owners: ['mcp', 'app'], inTests: false, exceptions: [] },
  { specifier: '@better-auth', owners: ['mcp', 'app'], inTests: false, exceptions: [] },

  // the Claude SDK's peer, and the lock library the Claude config lock is
  // checked against, which only that check imports
  { specifier: '@modelcontextprotocol/sdk', owners: [], inTests: true, exceptions: [] },
  {
    specifier: 'proper-lockfile',
    owners: [],
    inTests: true,
    exceptions: ['packages/app/src/agents/with-claude-config-lock.test.ts'],
  },
];
