import { NODE_TOKEN_FILE_ACCESS } from '@atc/config/token-file';
import type { MCPHTTPServer } from '@atc/mcp';
import { loadServiceTokenFile } from './load-service-token-file';
import type { ProcessIO } from './process-io';

interface ServiceTokenReload {
  // The name each error line starts with, such as `atc-gateway`.
  readonly binary: string;
  readonly path: string;
  readonly server: Pick<MCPHTTPServer, 'replaceServiceTokens'>;
  readonly io: Pick<ProcessIO, 'printError' | 'registerSignal'>;
}

// A SIGHUP reads the service-token file again. A file that fails to load, or
// that the server refuses, leaves the file in force and prints why.
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
