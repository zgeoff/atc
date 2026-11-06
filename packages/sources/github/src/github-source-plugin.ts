import { definePlugin } from '@atc/plugin-api';
import { z } from 'zod';
import { buildGitHubSource } from './build-github-source';

export const GITHUB_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'github',
  configFields: ['owner', 'bin'],
  configSchema: (context) =>
    z
      .object({ owner: z.string().nullable(), bin: z.string() })
      .transform((fields) => ({ ...fields, id: context.entryID })),
  create: (config, host) =>
    buildGitHubSource({
      id: config.id,
      run: host.runCommand,
      bin: config.bin,
      owner: config.owner,
    }),
});
