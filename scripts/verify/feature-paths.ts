// Globs are root-relative, as `git ls-files` prints them, and match with Bun.Glob.
const everyJourney = [
  'packages/{app,client,config,contract,core,daemon,lifecycle,plugin-api,protocol,reporters,store}/**',
  'packages/harnesses/**',
  'packages/execution/local/**',
  'packages/sources/**',
] as const;

export const featurePaths = {
  'docker-target': [
    ...everyJourney,
    'packages/execution/docker/**',
    'scripts/test-utils/run-docker-daemon.ts',
  ],

  'spawn-session': [...everyJourney, 'packages/tui/**'],
  'session-list-leader': [...everyJourney, 'packages/tui/**'],
  'kill-forget': [...everyJourney, 'packages/tui/**'],
  'events-stream': [...everyJourney],

  'mcp-fleet-tools': [...everyJourney, 'packages/mcp/**'],
  'session-messages': [...everyJourney, 'packages/mcp/**'],
  'cli-send': [...everyJourney],
  'remote-mcp-http': [...everyJourney, 'packages/mcp/**'],
  'gateway-routing': [...everyJourney, 'packages/mcp/**', 'packages/gateway/**'],
} as const satisfies Record<string, readonly string[]>;

export const sharedPaths = [
  'scripts/verify/**',
  'scripts/test-utils/run-local-daemon.ts',
  'scripts/{with-test-home.sh,create-state-template.ts,remove-stale-test-homes.ts,stop-test-home-processes.ts}',
  'packages/app/src/test-utils/build-stub-tui-claude.ts',
] as const;

export const ignoredPaths = [
  // Never `**/*.md`: a package may read markdown at run time.
  'docs/**',
  'scripts/serve-stub-daemon.ts',
  'scripts/smoke-client.mjs',
  '**/README.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  '**/*.test.ts',
  'e2e/**',
  'integration/**',

  // Bun never reads these when it runs the source.
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
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.github/**',
  '.vscode/**',

  'scripts/{build,check,collect,declaration,find,install,load,pack,pick,probe,publish,read,record,restore,run,stage,test,write}-*',
  'scripts/{deadcode.ts,with-e2e-paths.sh,disable-baseline.json}',
  'scripts/verify-gate/**',
  'scripts/{harmless-input-fields,is-breaking-marked}.ts',
  'scripts/test-utils/build-contract-schemas.ts',

  // A dependency bump merges on green CI, and the verify workflow skips a release pull request.
  '**/package.json',
  'bun.lock',
  '.bun-version',
  '.release-please-manifest.json',
  'release-please-config.json',

  // The journeys run the CLI's source, never the dev shim or an installed binary, and no journey configures an imp or a sprites target.
  'mods/**',
  'bin/atc',
  'install.sh',
  'packages/execution/imp/**',
  'packages/execution/sprites/**',
] as const;
