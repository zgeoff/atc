import { buildMockSessionDescriptor } from '@atc/protocol/test-utils/build-mock-session-descriptor';

// A session descriptor as the gateway sends it: the id names the daemon, and the locator holds the
// daemon's name and incarnation in place of its id.
export function buildMockGatewayDescriptor(): Readonly<Record<string, unknown>> {
  const { locator: _locator, ...descriptor } = buildMockSessionDescriptor({
    locator: { targetID: 'local' },
  });

  return {
    ...descriptor,
    id: 'build-box.k3f9.s7-m4x2p',
    locator: { daemon: 'build-box', incarnation: 'k3f9', targetID: 'local' },
  };
}
