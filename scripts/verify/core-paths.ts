// Every verify feature holds these paths, so a change to any of them flags every feature. When
// you can't tell whether a path reaches a feature, add it here: an extra journey costs less than a
// missed one.
export const corePaths = {
  // Every journey runs these package folders and the workspace packages each depends on.
  packages: [
    // the session fleet and protocol server that every journey's sessions run in
    'packages/daemon',

    // the daemon boot that every run starts with
    'packages/lifecycle',

    // the stand-in claude reports each hook event through these
    'packages/reporters',

    // the adapter of the stand-in claude that every session runs
    'packages/harnesses/claude',

    // the daemon builds every agent's adapter at start, and lists these as not installed
    'packages/harnesses/codex',
    'packages/harnesses/grok',

    // every session on the local target runs through this provider
    'packages/execution/local',

    // the daemon loads each source at start, and every spawn goes through their catalog
    'packages/sources/dirs',
    'packages/sources/git',
    'packages/sources/github',

    // every verify action and every client connects to the daemon through this
    'packages/client',

    // every `bun verify` command loads the MCP tools to list the read tools
    'packages/mcp',
  ],

  // List the app's files as globs: the app depends on every package, but each command loads only
  // its own modules.
  globs: [
    // every `atc` command starts here, and builds the whole command tree
    'packages/app/src/cli.ts',
    'packages/app/src/cli/**',

    // the command tree imports these argument parsers and commands for every `atc` command
    'packages/app/src/{send/parse-send-args,message-get/parse-message-get-args,auth/create-clients-command,auth/create-passkeys-command}.ts',

    // the daemon loads its agents, plugins and sources from these at start
    'packages/app/src/{daemon,agents,plugins,sources}/**',

    // the daemon connections that the TUI, `atc send` and `atc mcp --http` share
    'packages/app/src/{daemon-connection,remote-daemon}/**',

    // every `bun verify` command loads these docker helpers
    'packages/execution/docker/src/test-utils/{collect-session-containers,read-docker-lines,run-docker}.ts',

    // the stand-in claude that every run starts, beside test helpers that no journey runs
    'packages/app/src/test-utils/**',

    // the app runs these commands, but no journey checks them
    'packages/app/src/{config,workspaces}/**',
  ],
} as const;
