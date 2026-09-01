import { decodeMessage } from '../src/protocol/protocol';
import type { EventMsg } from '../src/protocol/protocol';

/**
 * Parses one NDJSON line into a wire event. Throws, naming the line, when
 * it decodes to anything but an event.
 */
export function parseEventLine(line: string): EventMsg {
  const decoded = decodeMessage(line);

  if (decoded.kind !== 'event') {
    throw new Error(`not an event line: ${line}`);
  }

  return decoded.msg;
}
