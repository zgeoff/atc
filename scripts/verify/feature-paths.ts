// Globs are root-relative, as `git ls-files` prints them, and match with Bun.Glob. A package is in
// a feature when the feature's journey runs code in it: every journey runs the daemon, a session of
// the stand-in claude, and the hook reporter it calls.
const everyJourney = [
  'packages/{app,config,contract,core,daemon,lifecycle,plugin-api,protocol,reporters,store}/**',
  'packages/harnesses/**',
  'packages/execution/local/**',
  'packages/sources/**',
] as const;

export const featurePaths = {
  'spawn-session': [...everyJourney, 'packages/tui/**'],
  'session-list-leader': [...everyJourney, 'packages/tui/**'],
  'kill-forget': [...everyJourney, 'packages/tui/**'],
  'events-stream': [...everyJourney],
} as const satisfies Record<string, readonly string[]>;

// A change to one of these changes every feature: the verify CLI, the test home it starts the
// daemon in, and the stand-in claude, which the test helpers build.
export const sharedPaths = [
  'scripts/verify/**',
  'scripts/{with-test-home.sh,create-state-template.ts,remove-stale-test-homes.ts,stop-test-home-processes.ts}',
  'packages/test-utils/**',
] as const;

// A path that one of these globs matches counts as no change, even where a feature's or a shared
// glob matches it too.
export const ignoredPaths = [
  // 1. No runtime effect: prose and tests. Never `**/*.md`: a package may read markdown at run time.
  'docs/**',
  '**/README.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  '**/*.test.ts',
  'e2e/**',
  'integration/**',

  // 2. Build, lint, CI and editor wiring, which Bun never reads when it runs the source.
  '**/tsconfig*.json',
  'bunfig.toml',
  'rig.config.ts',
  'knip.json',
  '.oxlintrc*.json',
  '.oxfmtrc.json',
  '.formatignore',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitleaks.toml',
  '.git-blame-ignore-revs',
  '.coderabbit.yaml',
  'commitlint.config.js',
  'lefthook.yml',
  'audit-ignores.json',
  'bun-test-timings.json',
  'socket.yml',
  'review.json',
  'renovate.json',
  'patches/**',
  '.claude/**',
  '.codex/**',
  '.github/**',
  '.vscode/**',

  // the repo scripts, by their verbs; the test home's scripts are shared paths above
  'scripts/{build,check,collect,declaration,find,install,load,pack,pick,probe,publish,read,record,restore,run,stage,test,write}-*',
  'scripts/{deadcode.ts,with-e2e-paths.sh,disable-baseline.json}',
  'scripts/verify-gate/**',

  // 3. The files that Renovate (the root catalog, the lock file, the Bun pin) and release-please
  //    (each package's version, the manifest) change. A dependency bump merges on green CI, and
  //    the verify workflow skips a release pull request.
  '**/package.json',
  'bun.lock',
  '.bun-version',
  '.release-please-manifest.json',
  'release-please-config.json',

  // 4. Code that no journey runs. The mod's embedded copy, which the daemon writes, lives in the
  //    claude harness; the journeys run the CLI's source, never the dev shim or an installed
  //    binary; and no journey configures an imp target, a gateway or an MCP client.
  'mods/**',
  'bin/atc',
  'install.sh',
  'packages/execution/imp/**',
  'packages/gateway/**',
  'packages/mcp/**',
] as const;
