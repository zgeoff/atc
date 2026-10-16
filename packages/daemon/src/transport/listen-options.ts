/**
 * The TCP listener's address and the file holding the tokens a handshake
 * may present, with the limits on its handshakes and its refusal log.
 */
export interface ListenOptions {
  readonly host: string;
  readonly port: number;
  readonly tokenFile: string;

  // How long a handshake waits once its source address has failed five
  // times within a minute; 10 s when unset.
  readonly failureDelayMs?: number;

  // How many delayed handshakes may wait at once across every address; 64
  // when unset.
  readonly maxDelayedHandshakes?: number;

  // How long the refusal log folds repeated refusals from one peer into one
  // line; a minute when unset.
  readonly refusalLogIntervalMs?: number;

  // How many peers and kinds of refusal the refusal log tracks at once;
  // 1024 when unset.
  readonly maxRefusalWindows?: number;
}
