import type { MessageGetRequest, SendRequest } from '../send/types';
import type { CommandLineIO } from './run-command-line';

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

export interface MCPCommandIO extends CommandLineIO {
  readonly runMCP: (flags: MCPFlags) => Promise<void>;
  readonly runMCPServiceSecret: () => Promise<void>;
}

export interface SendCommandIO extends CommandLineIO {
  readonly runSend: (request: SendRequest) => Promise<void>;
}

export interface MessageCommandIO extends CommandLineIO {
  readonly runMessageGet: (request: MessageGetRequest) => Promise<void>;
}
