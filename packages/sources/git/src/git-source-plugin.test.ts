import { expect, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils';
import { GIT_SOURCE_PLUGIN } from './git-source-plugin';

test('it creates the git URL source with the id of its config entry from an empty slice', () => {
  const context = { authProfiles: new Map(), entryID: 'urls', foreignFields: new Set<string>() };
  const config = GIT_SOURCE_PLUGIN.configSchema(context).parse({});
  const source = GIT_SOURCE_PLUGIN.create(config, buildMockHostServices(), context);

  expect(source.id).toBe('urls');
});
