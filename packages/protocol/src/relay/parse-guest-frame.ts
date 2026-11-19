/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import type { ParsedGuestFrame } from './guest-frame';
import { isFrameCount } from './is-frame-count';
import { parseFrameFields } from './parse-frame-fields';

export function parseGuestFrame(line: string): ParsedGuestFrame | null {
  const fields = parseFrameFields(line);

  if (fields === null) {
    return null;
  }

  const type = fields['t'];
  const version = fields['v'];
  const seq = fields['seq'];
  const conn = fields['conn'];
  const ack = fields['ack'];
  const relay = fields['relay'];
  const gen = fields['gen'];
  const reset = fields['reset'];
  const text = fields['line'];

  if (type === 'welcome' && typeof relay === 'string' && isFrameCount(gen)) {
    if (typeof version === 'number' && version !== 1) {
      return { t: type, v: version, relay, gen };
    }

    if (version === 1 && isFrameCount(ack) && typeof reset === 'boolean') {
      return { t: type, v: version, relay, gen, ack, reset };
    }

    return null;
  }

  if (type === 'open' && isFrameCount(seq) && isFrameCount(conn)) {
    return { t: type, seq, conn };
  }

  if (type === 'line' && isFrameCount(seq) && isFrameCount(conn) && typeof text === 'string') {
    return { t: type, seq, conn, line: text };
  }

  if ((type === 'end' || type === 'close') && isFrameCount(seq) && isFrameCount(conn)) {
    return { t: type, seq, conn };
  }

  if (type === 'ack' && isFrameCount(ack)) {
    return { t: type, ack };
  }

  return null;
}
