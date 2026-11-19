import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildLocalScratchPath } from './build-local-scratch-path';

test("it puts a session's scratch folder under the session's own folder in the state folder", () => {
  expect(buildLocalScratchPath(toSessionID('s1'), '/state/atc')).toBe(
    '/state/atc/sessions/s1/scratch',
  );
});
