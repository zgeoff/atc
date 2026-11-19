import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import type { CommandLineIO } from './run-command-line';

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

// The runs the `atc mcp` command and its subcommand hand their flags to.
export interface MCPCommandIO extends CommandLineIO {
  readonly runMCP: (flags: MCPFlags) => Promise<void>;
  readonly runMCPServiceSecret: () => Promise<void>;
}

export function createMCPCommand(io: MCPCommandIO) {
  return define({
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
}
