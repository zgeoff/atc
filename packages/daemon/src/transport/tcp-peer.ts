export interface TCPPeer {
  readonly verifyHandshake: (presented: string | null) => Promise<string | null>;

  readonly recordFailure: (reason: 'unexpected_line' | 'line_too_long') => void;

  // Never log the principal here: an unlisted one is whatever the peer sent, which can be a
  // credential.
  readonly recordRefusedPrincipal: () => void;
}
