import { expect, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import { GIT_SOURCE_PLUGIN } from './git-source-plugin';

test('it creates the git URL source from an empty slice', () => {
  const source = GIT_SOURCE_PLUGIN.create({}, buildMockHostServices(), {
    authProfiles: new Map(),
  });

  expect(source.id).toBe('git');
});
