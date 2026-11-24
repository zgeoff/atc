// An event as the gateway's merged trail sends it, with the merged cursor the test names.
export function buildMockFleetEvent(cursor: string): Record<string, unknown> {
  return {
    cursor,
    at: 1,
    session: 'build-box.k3f9.s7-m4x2p',
    name: null,
    kind: 'turn_done',
    detail: null,
    origin: { daemon: 'build-box', incarnation: 'k3f9', cursor: `d-${cursor}` },
  };
}
