/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import type { DaemonFrame } from './daemon-frame';
import { isFrameCount } from './is-frame-count';
import { parseFrameFields } from './parse-frame-fields';

// null for a line that is no frame.
export function parseDaemonFrame(line: string): DaemonFrame | null {
  const fields = parseFrameFields(line);

  if (fields === null) {
    return null;
  }

  const type = fields['t'];
  const seq = fields['seq'];
  const conn = fields['conn'];
  const ack = fields['ack'];
  const relay = fields['relay'];
  const gen = fields['gen'];
  const text = fields['line'];

  if (
    type === 'hello' &&
    fields['v'] === 1 &&
    typeof relay === 'string' &&
    isFrameCount(gen) &&
    isFrameCount(ack)
  ) {
    return { t: type, v: 1, relay, gen, ack };
  }

  if (type === 'line' && isFrameCount(seq) && isFrameCount(conn) && typeof text === 'string') {
    return { t: type, seq, conn, line: text };
  }

  if (type === 'close' && isFrameCount(seq) && isFrameCount(conn)) {
    return { t: type, seq, conn };
  }

  if (type === 'ack' && isFrameCount(ack)) {
    return { t: type, ack };
  }

  return null;
}
