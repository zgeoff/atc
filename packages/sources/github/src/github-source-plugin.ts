import { definePlugin } from '@atc/plugin-api/define-plugin';
import { z } from 'zod';
import { buildGitHubSource } from './build-github-source';

/**
 * The source plugin of GitHub repositories, which it lists through gh run
 * by the host's command runner. `owner` is the owner a listing without a
 * scope lists, or null for the gh account's own repositories, and `bin`
 * is the gh executable.
 */
export const GITHUB_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'github',
  configFields: ['owner', 'bin'],
  configSchema: () => z.object({ owner: z.string().nullable(), bin: z.string() }),
  create: (config, host) =>
    buildGitHubSource({ run: host.runCommand, bin: config.bin, owner: config.owner }),
});
