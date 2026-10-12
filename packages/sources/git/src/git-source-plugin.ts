import { definePlugin } from '@atc/plugin-api/define-plugin';
import { z } from 'zod';
import { buildGitSource } from './build-git-source';

/**
 * The source plugin of a typed git URL, which needs nothing beyond git and
 * takes no config.
 */
export const GIT_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'git',
  configFields: [],
  configSchema: () => z.object({}),
  create: () => buildGitSource(),
});
