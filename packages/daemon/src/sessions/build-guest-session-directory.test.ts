import { expect, test } from 'bun:test';
import { buildGuestSessionDirectory } from './build-guest-session-directory';

test("it places a session's own folder under the guest folder's sessions folder", () => {
  expect(buildGuestSessionDirectory('/var/atc', 's1')).toBe('/var/atc/sessions/s1');
});
