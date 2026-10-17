export interface TCPPeer {
  readonly verifyHandshake: (presented: string | null) => Promise<string | null>;

  // Counts a line other than a handshake, or one over the size cap, sent
  // before a handshake passed, as a failed handshake from the peer's
  // address.
  readonly recordFailure: (reason: 'unexpected_line' | 'line_too_long') => void;

  // Records a handshake or a request refused for a principal the config
  // does not list. The principal itself is never logged: an unlisted one
  // is whatever the peer sent, a credential included.
  readonly recordRefusedPrincipal: () => void;
}
