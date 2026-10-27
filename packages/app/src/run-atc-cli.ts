import type { runNote } from '@atc/reporters';
import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import pkg from '../package.json';
import type { runClients } from './clients';
import { createClientsCommand } from './create-clients-command';
import { createDaemonCommand } from './create-daemon-command';
import type { DaemonCommandIO } from './create-daemon-command';
import { createPasskeysCommand } from './create-passkeys-command';
import type { runPasskeys } from './passkeys';
import { makeMissingCommandRun, runCommandLine } from './run-command-line';
import type { CommandLineIO } from './run-command-line';

// The `atc mcp` flags, parsed.
interface MCPFlags {
  readonly http: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
  readonly tokenFile: string | null;
  readonly allowedOrigins: readonly string[];
}

export interface ATCCLIIO extends CommandLineIO, DaemonCommandIO {
  readonly runTUI: (daemon: string | null) => Promise<void>;
  readonly runMCP: (flags: MCPFlags) => Promise<void>;
  readonly runClients: (action: Parameters<typeof runClients>[0]) => Promise<void>;
  readonly runPasskeys: (action: Parameters<typeof runPasskeys>[0]) => Promise<void>;
  readonly runSession: (action: 'rebind' | 'adopt', id: string) => Promise<void>;
  readonly runGrants: (revoke: string | null) => Promise<void>;
  readonly runConfigMigrate: (file: string | null, write: boolean) => Promise<void>;
  readonly runBackup: (path: string) => Promise<void>;
  readonly runEvents: () => Promise<void>;
  readonly printCodexHooks: () => Promise<void>;
  readonly printGrokHooks: () => Promise<void>;
  readonly runHookReport: (agent: string) => Promise<void>;
  readonly runTap: (session: string, notices: boolean) => Promise<void>;
  readonly runNote: (...args: Readonly<Parameters<typeof runNote>>) => Promise<void>;
  readonly runStatusline: (agent: string) => Promise<void>;
}

const ATC_DESCRIPTION = 'Terminal control tower for coding-agent sessions';

const TUI_ARGS = {
  daemon: {
    type: 'string',
    description: "Connect to this daemon from the config's daemons map instead of the local daemon",
  },
} as const;

const SESSION_ID_ARG = {
  id: { type: 'positional', description: 'The atc session id' },
} as const;

// The commands a wrangled session runs, which must exit 0 whatever their
// command line holds.
const REPORTER_COMMANDS: ReadonlySet<string> = new Set([
  'hook-report',
  'statusline',
  'note',
  'answer',
  'unanswered',
]);

export async function runATCCLI(argv: readonly string[], io: ATCCLIIO): Promise<void> {
  const entry = define({
    name: 'atc',
    description: ATC_DESCRIPTION,
    args: TUI_ARGS,
    run: async (ctx) => {
      await io.runTUI(ctx.values.daemon ?? null);
    },
  });

  const tui = lazy(
    () => async (ctx) => {
      await io.runTUI(ctx.values.daemon ?? null);
    },
    { name: 'tui', description: 'Open the session list client', internal: true, args: TUI_ARGS },
  );

  const mcp = lazy(
    () => async (ctx) => {
      await io.runMCP({
        http: ctx.values.http,
        host: ctx.values.host ?? null,
        port: ctx.values.port ?? null,
        publicURL: ctx.values['public-url'] ?? null,
        waitForDaemon: ctx.values['wait-for-daemon'],
        tokenFile: ctx.values['token-file'] ?? null,
        allowedOrigins: ctx.values['allowed-origin'] ?? [],
      });
    },
    {
      name: 'mcp',
      description:
        'Run an MCP server exposing the fleet as tools: over stdio, or with --http behind OAuth',
      args: {
        http: { type: 'boolean', default: false, description: 'Serve MCP over HTTP behind OAuth' },
        host: { type: 'string', description: 'Address to bind with --http (default 127.0.0.1)' },
        port: integer({
          min: 0,
          max: 65_535,
          description: 'Port to listen on with --http, or 0 for a free one (default 8414)',
        }),
        'public-url': {
          type: 'string',
          description: 'Origin clients reach the --http server at, such as https://mcp.example.com',
        },
        'wait-for-daemon': {
          type: 'boolean',
          default: false,
          description:
            'With --http, wait for a running daemon instead of starting one, for a managed daemon',
        },
        'token-file': {
          type: 'string',
          description:
            "With --http, a file only you can read whose token opens live terminals as the daemon's owner; needs a loopback --host",
        },
        'allowed-origin': {
          type: 'string',
          multiple: true,
          description:
            "With --http, an origin whose pages may open a session's live terminal; repeat for more",
        },
      },
    },
  );

  const clients = createClientsCommand({
    serverName: 'atc mcp --http',
    sharedArgs: {},
    runClients: (action) => io.runClients(action),
  });

  const passkeys = createPasskeysCommand({
    serverName: 'atc mcp --http',
    sharedArgs: {},
    runPasskeys: (action) => io.runPasskeys(action),
  });

  const session = define({
    name: 'session',
    description: "Rebind a session's host or start its terminal, as the daemon's owner",
    subCommands: {
      rebind: lazy(
        () => async (ctx) => {
          await io.runSession('rebind', ctx.values.id);
        },
        {
          name: 'rebind',
          description: "Bind a session's host to its agent's current auth profiles; then adopt it",
          args: SESSION_ID_ARG,
        },
      ),
      adopt: lazy(
        () => async (ctx) => {
          await io.runSession('adopt', ctx.values.id);
        },
        {
          name: 'adopt',
          description: 'Start a terminal for a session that has none, resuming its agent',
          args: SESSION_ID_ARG,
        },
      ),
    },
    run: makeMissingCommandRun(io),
  });

  const grants = lazy(
    () => async (ctx) => {
      await io.runGrants(ctx.values.revoke ?? null);
    },
    {
      name: 'grants',
      description: 'List the grants atc mcp --http clients hold, or revoke one with --revoke=<id>',
      args: { revoke: { type: 'string', description: 'The ID of a grant to revoke' } },
    },
  );

  const config = define({
    name: 'config',
    description: "Work on atc's config.json",
    subCommands: {
      migrate: lazy(
        () => async (ctx) => {
          await io.runConfigMigrate(ctx.values.file ?? null, ctx.values.write);
        },
        {
          name: 'migrate',
          description:
            'Move the old agent keys of config.json into agents: print the result, or rewrite the file with --write',
          args: {
            write: {
              type: 'boolean',
              default: false,
              description: 'Back the file up beside itself, then rewrite it in place',
            },
            file: {
              type: 'string',
              description: 'The config file to migrate (default ~/.config/atc/config.json)',
            },
          },
        },
      ),
    },
    run: makeMissingCommandRun(io),
  });

  const daemon = createDaemonCommand(io);

  const backup = lazy(
    () => async (ctx) => {
      await io.runBackup(ctx.values.path);
    },
    {
      name: 'backup',
      description: "Write a consistent copy of the running daemon's state database to a file",
      args: {
        path: { type: 'positional', description: 'The file to write, replacing any file there' },
      },
    },
  );

  const events = lazy(
    () => async () => {
      await io.runEvents();
    },
    { name: 'events', description: 'Stream daemon wire events to stdout as NDJSON' },
  );

  const codexHooks = lazy(
    () => async () => {
      await io.printCodexHooks();
    },
    {
      name: 'codex-hooks',
      description:
        'Print the Codex hook entries to merge into $CODEX_HOME/hooks.json (trust them once in the Codex TUI)',
    },
  );

  const grokHooks = lazy(
    () => async () => {
      await io.printGrokHooks();
    },
    {
      name: 'grok-hooks',
      description: 'Print the Grok hook file to install at $GROK_HOME/hooks/atc-reporter.json',
    },
  );

  const hookReport = lazy(
    () => async (ctx) => {
      await io.runHookReport(ctx.values.agent);
    },
    {
      name: 'hook-report',
      description: 'Forward a hook event from a wrangled session to the atc socket',
      internal: true,
      args: { agent: { type: 'string', default: '' } },
    },
  );

  const tap = lazy(
    () => async (ctx) => {
      await io.runTap(ctx.values.session, ctx.values.notices);
    },
    {
      name: 'tap',
      description: "Stream a session's inbox to stdout as NDJSON, acking each message",
      args: {
        session: { type: 'string', required: true, description: 'The atc session id to tap' },
        notices: {
          type: 'boolean',
          default: false,
          description: 'Also stream the answer notices of the messages the session sent',
        },
      },
    },
  );

  const note = lazy(
    () => async (ctx) => {
      await io.runNote('note', { message: '', messages: '', label: ctx.values.label, turn: '' });
    },
    {
      name: 'note',
      description: 'Send a note from a wrangled session to the atc socket',
      internal: true,
      args: { label: { type: 'string', default: '' } },
    },
  );

  const answer = lazy(
    () => async (ctx) => {
      await io.runNote('answered', {
        message: ctx.values.message,
        messages: ctx.values.messages,
        label: '',
        turn: ctx.values.turn,
      });
    },
    {
      name: 'answer',
      description: 'Record the answer of a turn for the messages it answered',
      internal: true,
      args: {
        message: { type: 'string', default: '' },
        messages: { type: 'string', default: '' },
        turn: { type: 'string', default: '' },
      },
    },
  );

  const unanswered = lazy(
    () => async (ctx) => {
      await io.runNote('unanswered', {
        message: '',
        messages: ctx.values.messages,
        label: '',
        turn: ctx.values.turn,
        reason: ctx.values.reason,
      });
    },
    {
      name: 'unanswered',
      description: 'Record that the turn carrying some messages ended without an answer',
      internal: true,
      args: {
        messages: { type: 'string', default: '' },
        turn: { type: 'string', default: '' },
        reason: { type: 'string', default: '' },
      },
    },
  );

  const statusline = lazy(
    () => async (ctx) => {
      await io.runStatusline(ctx.values.agent);
    },
    {
      name: 'statusline',
      description: 'Render the chained statusline for a wrangled session',
      internal: true,
      args: { agent: { type: 'string', default: '' } },
    },
  );

  await runCommandLine(
    argv,
    entry,
    {
      name: 'atc',
      version: pkg.version,
      description: ATC_DESCRIPTION,
      subCommands: {
        tui,
        mcp,
        clients,
        passkeys,
        session,
        grants,
        config,
        daemon,
        backup,
        events,
        'codex-hooks': codexHooks,
        'grok-hooks': grokHooks,
        'hook-report': hookReport,
        tap,
        note,
        answer,
        unanswered,
        statusline,
      },
      lenient: REPORTER_COMMANDS,
    },
    io,
  );
}
