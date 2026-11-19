import { expect, test } from 'bun:test';
import { buildRemoteListingCachePath } from './build-remote-listing-cache-path';

test("it places a daemon's listing cache beside the local one, named for the daemon", () => {
  const path = buildRemoteListingCachePath('/home/u/.local/state/atc/listing-cache.json', 'box');

  expect(path).toBe('/home/u/.local/state/atc/listing-cache-box.json');
});
