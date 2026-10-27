import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import invariant from 'tiny-invariant';
import type { TokenFileAccess } from './load-listener-tokens';

export const NODE_TOKEN_FILE_ACCESS: TokenFileAccess = {
  openFile: (path) => openSync(path, 'r'),
  statFile: (descriptor) => fstatSync(descriptor),
  readFile: (descriptor) => readFileSync(descriptor, 'utf8'),
  closeFile: (descriptor) => {
    closeSync(descriptor);
  },
  readUserID: () => {
    invariant(process.getuid, 'atc runs only where processes have user ids');

    return process.getuid();
  },
};
