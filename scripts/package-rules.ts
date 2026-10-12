// The workspace packages and the internal packages each may depend on: the
// package plan's dependency order. The oxlint import rules, check-manifests
// and check-reach all read this one table. A package is named `@atc/<name>`
// and lives at its directory whether or not the directory exists yet, so the
// rules hold for a package from the change that creates it.
export interface PackageRule {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];

  // a front end's tests may use the daemon's testing entry, which its
  // production code may not reach
  readonly isFrontEnd: boolean;
}

const PLUGIN_DEPS = ['plugin-api', 'core', 'config', 'protocol'];
const FRONT_END_DEPS = ['core', 'protocol', 'config'];

const LIBRARIES: readonly PackageRule[] = [
  { name: 'core', dir: 'packages/core', deps: [], isFrontEnd: false },
  { name: 'protocol', dir: 'packages/protocol', deps: ['core'], isFrontEnd: false },
  { name: 'plugin-api', dir: 'packages/plugin-api', deps: ['core', 'protocol'], isFrontEnd: false },
  { name: 'config', dir: 'packages/config', deps: ['core', 'plugin-api'], isFrontEnd: false },
  { name: 'store', dir: 'packages/store', deps: ['core', 'protocol', 'config'], isFrontEnd: false },
  {
    name: 'lifecycle',
    dir: 'packages/lifecycle',
    deps: ['core', 'protocol', 'config', 'store'],
    isFrontEnd: false,
  },
  {
    name: 'daemon',
    dir: 'packages/daemon',
    deps: ['core', 'protocol', 'plugin-api', 'config', 'store', 'lifecycle'],
    isFrontEnd: false,
  },
  {
    name: 'harness-claude',
    dir: 'packages/harnesses/claude',
    deps: PLUGIN_DEPS,
    isFrontEnd: false,
  },
  { name: 'harness-codex', dir: 'packages/harnesses/codex', deps: PLUGIN_DEPS, isFrontEnd: false },
  { name: 'harness-grok', dir: 'packages/harnesses/grok', deps: PLUGIN_DEPS, isFrontEnd: false },
  {
    name: 'execution-local',
    dir: 'packages/execution/local',
    deps: PLUGIN_DEPS,
    isFrontEnd: false,
  },
  { name: 'execution-imp', dir: 'packages/execution/imp', deps: PLUGIN_DEPS, isFrontEnd: false },
  { name: 'source-dirs', dir: 'packages/sources/dirs', deps: PLUGIN_DEPS, isFrontEnd: false },
  { name: 'source-github', dir: 'packages/sources/github', deps: PLUGIN_DEPS, isFrontEnd: false },
  { name: 'source-git', dir: 'packages/sources/git', deps: PLUGIN_DEPS, isFrontEnd: false },
  { name: 'tui', dir: 'packages/tui', deps: FRONT_END_DEPS, isFrontEnd: true },
  { name: 'mcp', dir: 'packages/mcp', deps: FRONT_END_DEPS, isFrontEnd: true },
  { name: 'gateway', dir: 'packages/gateway', deps: FRONT_END_DEPS, isFrontEnd: true },
  { name: 'reporters', dir: 'packages/reporters', deps: FRONT_END_DEPS, isFrontEnd: true },
  {
    name: 'test-utils',
    dir: 'packages/test-utils',
    deps: ['core', 'protocol', 'config', 'plugin-api'],
    isFrontEnd: false,
  },
];

// app holds both entrypoints, which wire every other package together
export const PACKAGE_RULES: readonly PackageRule[] = [
  ...LIBRARIES,
  {
    name: 'app',
    dir: 'packages/app',
    deps: LIBRARIES.map((rule) => rule.name),
    isFrontEnd: false,
  },
];
