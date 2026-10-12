import { expect, test } from 'bun:test';
import { requireDaemonFeatures } from './require-daemon-features';

test('it lets a request through when the daemon announces every feature it needs', () => {
  expect(() => {
    requireDaemonFeatures(new Set(['events.session', 'message.wait']), ['events.session']);
  }).not.toThrow();
});

test('it refuses a request whose feature the daemon lacks with a restart hint', () => {
  expect(() => {
    requireDaemonFeatures(new Set(), ['events.session']);
  }).toThrowWithMessage(
    Error,
    /^daemon_outdated: .*atc_events_read's session filter\. Restart the daemon/,
  );
});
