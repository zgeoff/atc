// A complete hello answer, so a stub daemon that is not about the hello still accepts one.
export function buildStubHelloAnswer(): Readonly<Record<string, unknown>> {
  return {
    daemon: 'atc/stub-build',
    daemonID: 'd-stub',
    limits: { maxLine: 4 * 1024 * 1024, maxChunk: 64 * 1024 },
    idempotency: { completedRetentionMs: 60_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
    features: [],
  };
}
