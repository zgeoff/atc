import type { MessageGetRequest, SendRequest } from '../send/types';
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

// The run the `atc send` command hands its parsed request to.
export interface SendCommandIO extends CommandLineIO {
  readonly runSend: (request: SendRequest) => Promise<void>;
}

// The run the `atc message get` command hands its parsed request to.
export interface MessageCommandIO extends CommandLineIO {
  readonly runMessageGet: (request: MessageGetRequest) => Promise<void>;
}
