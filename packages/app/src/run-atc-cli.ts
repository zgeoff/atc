import type { runNote } from '@atc/reporters';
import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import pkg from '../package.json';
import type { runClients } from './clients';
import { createClientsCommand } from './create-clients-command';
import { createDaemonCommand } from './create-daemon-command';
import type { DaemonCommandIO } from './create-daemon-command';
import { createPasskeysCommand } from './create-passkeys-command';
import { parseMessageGetArgs } from './parse-message-get-args';
import { parseSendArgs } from './parse-send-args';
import type { runPasskeys } from './passkeys';
import { makeMissingCommandRun, refuseCommandLine, runCommandLine } from './run-command-line';
import type { CommandLineIO } from './run-command-line';
import type { MessageGetRequest, SendRequest } from './send-types';

// The `atc mcp` flags, parsed.
interface MCPFlags {
  readonly http: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
  readonly tokenFile: string | null;
  readonly serviceTokenFile: string | null;
  readonly allowedOrigins: readonly string[];
  readonly daemon: string | null;
}

export interface ATCCLIIO extends CommandLineIO, DaemonCommandIO {
  readonly runTUI: (daemon: string | null) => Promise<void>;
  readonly runMCP: (flags: MCPFlags) => Promise<void>;
  readonly runMCPServiceSecret: () => Promise<void>;
  readonly runClients: (action: Parameters<typeof runClients>[0]) => Promise<void>;
  readonly runPasskeys: (action: Parameters<typeof runPasskeys>[0]) => Promise<void>;
  readonly runSession: (action: 'rebind' | 'adopt', id: string) => Promise<void>;
  readonly runGrants: (revoke: string | null) => Promise<void>;
  readonly runConfigMigrate: (file: string | null, write: boolean) => Promise<void>;
  readonly runBackup: (path: string) => Promise<void>;
  readonly runWorkspacesPrune: (remove: boolean) => Promise<void>;
  readonly runEvents: () => Promise<void>;
  readonly runSend: (request: SendRequest) => Promise<void>;
  readonly runMessageGet: (request: MessageGetRequest) => Promise<void>;
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

// The commands a script runs and branches on, which exit 2 on a command
// line they refuse.
const SCRIPT_COMMAND_USAGE_EXITS: ReadonlyMap<string, number> = new Map([
  ['send', 2],
  ['message', 2],
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

  const mcp = define({
    name: 'mcp',
    description:
      'Run an MCP server exposing the fleet as tools: over stdio, or with --http behind OAuth',
    subCommands: {
      'service-secret': lazy(
        () => async () => {
          await io.runMCPServiceSecret();
        },
        {
          name: 'service-secret',
          description:
            'Print a new service client secret once, with the digest for the service-token file',
        },
      ),
    },
    run: async (ctx) => {
      await io.runMCP({
        http: ctx.values.http,
        host: ctx.values.host ?? null,
        port: ctx.values.port ?? null,
        publicURL: ctx.values['public-url'] ?? null,
        waitForDaemon: ctx.values['wait-for-daemon'],
        tokenFile: ctx.values['token-file'] ?? null,
        serviceTokenFile: ctx.values['service-token-file'] ?? null,
        allowedOrigins: ctx.values['allowed-origin'] ?? [],
        daemon: ctx.values.daemon ?? null,
      });
    },
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
      'service-token-file': {
        type: 'string',
        description:
          'With --http, a JSON file of service clients that /mcp accepts beside OAuth tokens; read at start and again on SIGHUP',
      },
      'allowed-origin': {
        type: 'string',
        multiple: true,
        description:
          "With --http, an origin whose pages may open a session's live terminal; repeat for more",
      },
      daemon: {
        type: 'string',
        description:
          "Serve the tools against this daemon from the config's daemons map instead of the local daemon; with --http, that daemon's principals must list each connector",
      },
    },
  });

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

  const workspaces = define({
    name: 'workspaces',
    description: 'Work on the workspaces and state folders atc created',
    subCommands: {
      prune: lazy(
        () => async (ctx) => {
          await io.runWorkspacesPrune(ctx.values.yes);
        },
        {
          name: 'prune',
          description:
            'List the workspaces and state folders no listed session owns, with the size and verdict of each; remove the safe ones with --yes',
          args: {
            yes: {
              type: 'boolean',
              default: false,
              description: 'Remove each folder the list marks remove',
            },
          },
        },
      ),
    },
    run: makeMissingCommandRun(io),
  });

  const send = lazy(
    () => async (ctx) => {
      const parsed = parseSendArgs({
        session: ctx.values.session,
        text: ctx.values.text,
        key: ctx.values.key,
        wait: ctx.values.wait,
        timeout: ctx.values.timeout,
        from: ctx.values.from,
        owner: ctx.values.owner,
        daemon: ctx.values.daemon,
        json: ctx.values.json,
      });

      if (!parsed.ok) {
        await refuseCommandLine(io, ctx, parsed.message, 2);

        return;
      }

      await io.runSend(parsed.request);
    },
    {
      name: 'send',
      description:
        'Send a session a message from a script; with --wait, wait for its answer. Exits 0 sent or answered, 1 refused, 2 usage, 3 no session, 4 daemon not reached, 5 not delivered, 6 delivery unknown, 7 unanswered, 8 wait timed out',
      args: {
        session: { type: 'positional', description: 'The session id, or its exact name' },
        text: {
          type: 'positional',
          required: false,
          description: 'The message text; "-" or none reads stdin',
        },
        key: {
          type: 'string',
          description: 'The idempotency key, so a retry sends once (default: a new key, printed)',
        },
        wait: {
          type: 'boolean',
          default: false,
          description: 'Wait for the message to be answered',
        },
        timeout: integer({
          min: 1,
          description: 'With --wait, how many seconds to wait (default 300)',
        }),
        from: { type: 'string', description: 'The sender name of the message (default atc-send)' },
        owner: { type: 'boolean', default: false, description: 'Send as the owner' },
        daemon: {
          type: 'string',
          description: "Send to this daemon from the config's daemons map",
        },
        json: { type: 'boolean', default: false, description: 'Print one JSON object on stdout' },
      },
    },
  );

  const message = define({
    name: 'message',
    description: 'Read a message sent to a session',
    subCommands: {
      get: lazy(
        () => async (ctx) => {
          const parsed = parseMessageGetArgs({
            message: ctx.values.message,
            wait: ctx.values.wait,
            timeout: ctx.values.timeout,
            daemon: ctx.values.daemon,
            json: ctx.values.json,
          });

          if (!parsed.ok) {
            await refuseCommandLine(io, ctx, parsed.message, 2);

            return;
          }

          await io.runMessageGet(parsed.request);
        },
        {
          name: 'get',
          description:
            "Print a message's status and answer; with --wait, wait for the answer. Exits 0 queued, delivered or answered, 1 refused, 2 usage, 4 daemon not reached, 7 unanswered, 8 wait timed out",
          args: {
            message: { type: 'positional', description: 'The message id' },
            wait: {
              type: 'boolean',
              default: false,
              description: 'Wait for the message to be answered',
            },
            timeout: integer({
              min: 1,
              description: 'With --wait, how many seconds to wait (default 300)',
            }),
            daemon: {
              type: 'string',
              description: "Read from this daemon from the config's daemons map",
            },
            json: {
              type: 'boolean',
              default: false,
              description: 'Print the message as one JSON object on stdout',
            },
          },
        },
      ),
    },
    run: makeMissingCommandRun(io),
  });

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
        workspaces,
        events,
        send,
        message,
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
      usageExits: SCRIPT_COMMAND_USAGE_EXITS,
    },
    io,
  );
}
