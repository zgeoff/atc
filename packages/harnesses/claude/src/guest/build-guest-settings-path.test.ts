import { expect, test } from 'bun:test';
import { buildGuestSettingsPath } from './build-guest-settings-path';

test("it places a guest launch's settings file in the session's own folder", () => {
  expect(buildGuestSettingsPath('/var/atc/sessions/s1')).toBe('/var/atc/sessions/s1/settings.json');
});
