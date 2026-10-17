import { definePlugin } from '@atc/plugin-api';
import { z } from 'zod';
import { buildGitSource } from './build-git-source';

export const GIT_SOURCE_PLUGIN = definePlugin({
  kind: 'source',
  id: 'git',
  configFields: [],
  configSchema: () => z.object({}),
  create: () => buildGitSource(),
});
