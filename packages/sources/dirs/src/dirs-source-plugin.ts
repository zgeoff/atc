import { definePlugin } from '@atc/plugin-api';
import { z } from 'zod';
import { buildDirsSource } from './build-dirs-source';
import { readZoxideDirs } from './read-zoxide-dirs';

export const DIRS_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'dirs',
  configFields: ['roots', 'homeDir'],
  configSchema: (context) =>
    z
      .object({ roots: z.array(z.string()), homeDir: z.string() })
      .transform((fields) => ({ ...fields, id: context.entryID })),
  create: (config, host) =>
    buildDirsSource({
      id: config.id,
      roots: config.roots,
      homeDir: config.homeDir,
      readZoxideDirs: () => readZoxideDirs(host.runCommand),
    }),
});
