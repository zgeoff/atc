import type { HarnessRelay } from '@atc/plugin-api';

// While a line waits for room in the relay, the socket takes no bytes, so
// the connection's own queue holds them and its cap applies.
export function createRelayPeerSocket(relay: HarnessRelay, onDrain: () => void) {
  const decoder = new TextDecoder();

  let partial = '';
  let waiting = 0;

  const writeRelayLine = async (line: string) => {
    try {
      await relay.writeLine(line);
    } catch {
      // A relay that closed takes no more lines; its close ends the connection.
    }

    waiting -= 1;

    if (waiting === 0) {
      onDrain();
    }
  };

  return {
    write: (data: Uint8Array): number => {
      if (waiting > 0) {
        return 0;
      }

      const lines = `${partial}${decoder.decode(data, { stream: true })}`.split('\n');

      partial = lines.pop() ?? '';

      for (const line of lines) {
        waiting += 1;
        void writeRelayLine(line);
      }

      return data.length;
    },
    end: () => {
      relay.close();
    },
  };
}
