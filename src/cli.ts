// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import { getBuild } from './get-build';

const main = defineCommand({
  meta: {
    name: 'atc',
    version: pkg.version,
    description: 'Terminal control tower for Claude Code sessions',
  },
  default: 'tui',
  subCommands: {
    tui: () =>
      defineCommand({
        meta: {
          name: 'tui',
          description: 'Open the session list client',
          hidden: true,
        },
        async run() {
          await import('./index');
        },
      }),
    mcp: () =>
      defineCommand({
        meta: {
          name: 'mcp',
          description: 'Run an MCP server over stdio exposing the fleet as tools',
        },
        async run() {
          const server = await import('./mcp-server');

          await server.runMCPServer(getBuild());
        },
      }),
    daemon: () =>
      defineCommand({
        meta: {
          name: 'daemon',
          description: 'Run the atc daemon in the foreground',
        },
        async run() {
          const daemon = await import('./daemon');
          const config = await import('./config');
          const claude = await import('./claude-adapter');
          const headless = await import('./start-headless-run');

          // Test harnesses shrink the outbound queue to force overflow
          // deterministically; unset means the production default.
          const queueBytes = Number(process.env['ATC_QUEUE_BYTES']);
          const cfg = config.loadConfig();

          // Cap on how long a fleet restore waits for one revived session to
          // report it has booted before moving to the next. Tests pin it to
          // keep timing deterministic; unset means the production default.
          const capOverride = Number(process.env['ATC_RESTORE_BOOT_TIMEOUT_MS']);

          const restoreBootTimeoutMs =
            Number.isFinite(capOverride) && capOverride >= 0 ? capOverride : 15_000;

          const handle = daemon.startDaemon({
            headlessRunner: (runOpts, hooks) => headless.startHeadlessRun(runOpts, hooks),
            socketPath: config.daemonSocketPath,
            reporterSocketPath: config.socketPath,
            build: getBuild(),
            adapter: new claude.ClaudeAdapter(cfg),
            dbPath: config.dbFile,
            legacyFleetPath: config.legacyFleetFile,
            pidPath: config.daemonPidFile,
            restoreBootTimeoutMs,
            ...(Number.isFinite(queueBytes) && queueBytes > 0 ? { queueBytes } : {}),
            onQuit: () => process.exit(0),
          });

          process.on('SIGTERM', () => {
            handle.stop();
            process.exit(0);
          });
        },
      }),
    'hook-report': () =>
      defineCommand({
        meta: {
          name: 'hook-report',
          description: 'Forward a hook event from a wrangled session to the atc socket',
          hidden: true,
        },
        async run() {
          const reporter = await import('./hook-report');

          await reporter.runHookReport();
        },
      }),
    statusline: () =>
      defineCommand({
        meta: {
          name: 'statusline',
          description: 'Render the chained statusline for a wrangled session',
          hidden: true,
        },
        async run() {
          const statusline = await import('./statusline');

          await statusline.runStatusline();
        },
      }),
  },
});

await runMain(main);
