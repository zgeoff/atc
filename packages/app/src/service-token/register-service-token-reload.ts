import { NODE_TOKEN_FILE_ACCESS } from '@atc/config/token-file';
import type { MCPHTTPServer } from '@atc/mcp';
import type { ProcessIO } from '../cli/process-io';
import { loadServiceTokenFile } from './load-service-token-file';

interface ServiceTokenReload {
  readonly binary: string;
  readonly path: string;
  readonly server: Pick<MCPHTTPServer, 'replaceServiceTokens'>;
  readonly io: Pick<ProcessIO, 'printError' | 'registerSignal'>;
}

export function registerServiceTokenReload(options: ServiceTokenReload): void {
  const printFault = (reason: string): void => {
    options.io.printError(`${options.binary}: --service-token-file: ${reason}`);
  };

  options.io.registerSignal('SIGHUP', () => {
    const loaded = loadServiceTokenFile(options.path, NODE_TOKEN_FILE_ACCESS);

    if (!loaded.ok) {
      printFault(loaded.reason);

      return Promise.resolve();
    }

    try {
      options.server.replaceServiceTokens(loaded.file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      printFault(reason);
    }

    return Promise.resolve();
  });
}
