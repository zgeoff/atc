import { definePlugin } from '@atc/plugin-api';
import { z } from 'zod';
import { buildDirsSource } from './build-dirs-source';
import { readZoxideDirs } from './read-zoxide-dirs';

export const DIRS_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'dirs',
  configFields: ['roots', 'homeDir'],
  configSchema: () => z.object({ roots: z.array(z.string()), homeDir: z.string() }),
  create: (config, host) =>
    buildDirsSource({
      roots: config.roots,
      homeDir: config.homeDir,
      readZoxideDirs: () => readZoxideDirs(host.runCommand),
    }),
});
