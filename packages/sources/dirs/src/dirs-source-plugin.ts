import { definePlugin } from '@atc/plugin-api/define-plugin';
import { z } from 'zod';
import { buildDirsSource } from './build-dirs-source';
import { collectZoxideDirs } from './collect-zoxide-dirs';

/**
 * The source plugin of the directories on the daemon's host: the children
 * of the configured roots, zoxide's frecency list, and typed paths under
 * the daemon user's home. It runs zoxide through the host's command runner.
 */
export const DIRS_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'dirs',
  configFields: ['roots', 'homeDir'],
  configSchema: () => z.object({ roots: z.array(z.string()), homeDir: z.string() }),
  create: (config, host) =>
    buildDirsSource({
      roots: config.roots,
      homeDir: config.homeDir,
      collectZoxideDirs: () => collectZoxideDirs(host.runCommand),
    }),
});
