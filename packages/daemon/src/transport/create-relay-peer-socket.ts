import type { HarnessRelay } from '@atc/plugin-api';

export function createRelayPeerSocket(relay: HarnessRelay, onDrain: () => void) {
  const decoder = new TextDecoder();

  let partial = '';
  let waiting = 0;
  let isEnding = false;

  const writeRelayLine = async (line: string) => {
    try {
      await relay.writeLine(line);
    } catch {
      // A relay that closed takes no more lines; its close ends the connection.
    }

    waiting -= 1;

    if (waiting > 0) {
      return;
    }

    if (isEnding) {
      relay.close();
    } else {
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
      isEnding = true;

      if (waiting === 0) {
        relay.close();
      }
    },
  };
}
